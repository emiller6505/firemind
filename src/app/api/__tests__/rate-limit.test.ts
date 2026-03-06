import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/query/index', () => ({ streamPipeline: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/query-cache', () => ({ cacheGet: vi.fn().mockReturnValue(null), cacheSet: vi.fn() }))
vi.mock('@/lib/circuit-breaker', () => ({ checkCircuitBreaker: vi.fn() }))
vi.mock('@/lib/ip-rate-limit', () => ({ checkIpLimit: vi.fn() }))
vi.mock('@/lib/get-client-ip', () => ({ getClientIp: vi.fn(() => '127.0.0.1') }))
vi.mock('@/lib/connection-limiter', () => ({ acquireConnection: vi.fn(() => true), releaseConnection: vi.fn() }))
vi.mock('@/lib/query-blocklist', () => ({ checkBlocklist: vi.fn(() => ({ blocked: false, pattern: '' })) }))
vi.mock('@/query/decklist', () => ({ parseDecklist: vi.fn(() => null), validateDecklist: vi.fn(() => []), formatValidationWarning: vi.fn(), fixCopyLimits: vi.fn(), renderDecklist: vi.fn() }))

import { streamPipeline } from '@/query/index'
import { createClient } from '@/lib/supabase-server'
import { cacheGet } from '@/lib/query-cache'
import { checkCircuitBreaker } from '@/lib/circuit-breaker'
import { checkIpLimit } from '@/lib/ip-rate-limit'
import { POST } from '../query/route'
import { USER_LIMIT, WINDOW_MS } from '@/lib/rate-limit-constants'

const MOCK_INTENT = { format: 'modern' as const, question_type: 'metagame' as const, archetype: null, archetype_b: null, opponent_archetype: null, card: null, card_mentions: [] as string[], timeframe_days: 90 as const }
const MOCK_DATA = { format: 'modern', window_days: 90, tournaments_count: 1, top_decks: [], card_info: null, card_glossary: [], article_chunks: [], confidence: 'HIGH' as const }

function makeReq(body: unknown) {
  return {
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as import('next/server').NextRequest
}

async function readSSEEvents(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text()
  const events: Array<{ event: string; data: unknown }> = []
  const blocks = text.split('\n\n').filter(b => b.trim())
  for (const block of blocks) {
    const lines = block.split('\n')
    let event = ''
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (event && data) events.push({ event, data: JSON.parse(data) })
  }
  return events
}

function findEvent(events: Array<{ event: string; data: unknown }>, name: string) {
  return events.find(e => e.event === name)
}

let mockRpc: ReturnType<typeof vi.fn>
let mockSupabase: Record<string, unknown>

function setupMocks(opts: {
  user: { id: string } | null
  rpcResult: { allowed: boolean; new_count: number; window_start: string }
}) {
  mockRpc = vi.fn().mockResolvedValue({
    data: [opts.rpcResult],
  })

  mockSupabase = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    rpc: mockRpc,
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        gte: vi.fn().mockResolvedValue({ count: 0 }),
      }),
    }),
  }

  vi.mocked(createClient).mockResolvedValue(mockSupabase as never)
}

function mockStreamPipeline() {
  vi.mocked(streamPipeline).mockImplementation(async (_query, _history, rateLimit, emit) => {
    emit('progress', { stage: 'intent', pct: 10, label: 'Understanding your question…' })
    emit('meta', { intent: MOCK_INTENT, data: MOCK_DATA, rate_limit: rateLimit })
    emit('delta', { text: 'answer' })
    return { intent: MOCK_INTENT, data: MOCK_DATA, fullAnswer: 'answer' }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(cacheGet).mockReturnValue(null)
  vi.mocked(checkCircuitBreaker).mockResolvedValue(true)
  vi.mocked(checkIpLimit).mockReturnValue({ allowed: true })
  mockStreamPipeline()
})

describe('POST /api/query rate limiting', () => {
  it('anon user gets tier=anon with remaining=null, resets_at=null', async () => {
    const windowStart = new Date().toISOString()
    setupMocks({ user: null, rpcResult: { allowed: true, new_count: 1, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = findEvent(events, 'meta')!.data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.tier).toBe('anon')
    expect(rl.remaining).toBeNull()
    expect(rl.resets_at).toBeNull()
  })

  it('authed user with first query gets remaining = USER_LIMIT - 1', async () => {
    const windowStart = new Date().toISOString()
    setupMocks({ user: { id: 'u1' }, rpcResult: { allowed: true, new_count: 1, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = findEvent(events, 'meta')!.data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.tier).toBe('user')
    expect(rl.remaining).toBe(USER_LIMIT - 1)
    expect(rl.resets_at).toBeTruthy()
  })

  it('authed user calls atomic RPC with correct params', async () => {
    const windowStart = new Date().toISOString()
    setupMocks({ user: { id: 'u1' }, rpcResult: { allowed: true, new_count: 1, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    await res.text()

    expect(mockRpc).toHaveBeenCalledWith('increment_oracle_query', {
      p_user_id: 'u1',
      p_limit: USER_LIMIT,
      p_window_ms: WINDOW_MS,
    })
  })

  it('authed user with active window (count=6) gets remaining=4', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    setupMocks({ user: { id: 'u1' }, rpcResult: { allowed: true, new_count: 6, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = findEvent(events, 'meta')!.data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.remaining).toBe(USER_LIMIT - 6)
  })

  it('returns 429 when authed user is at the limit', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    setupMocks({ user: { id: 'u1' }, rpcResult: { allowed: false, new_count: USER_LIMIT, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('rate_limit_exceeded')
    expect(body.rate_limit.remaining).toBe(0)
    expect(body.rate_limit.tier).toBe('user')
  })

  it('429 resets_at is window_start + 24h', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    setupMocks({ user: { id: 'u1' }, rpcResult: { allowed: false, new_count: USER_LIMIT, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const body = await res.json()

    const expected = new Date(new Date(windowStart).getTime() + WINDOW_MS).toISOString()
    expect(body.rate_limit.resets_at).toBe(expected)
  })

  it('anon user does not call RPC', async () => {
    const windowStart = new Date().toISOString()
    setupMocks({ user: null, rpcResult: { allowed: true, new_count: 1, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    await res.text()

    expect(mockRpc).not.toHaveBeenCalled()
  })
})
