import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/query/index', () => ({ handleQueryStream: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/query-cache', () => ({ cacheGet: vi.fn().mockReturnValue(null), cacheSet: vi.fn() }))

import { handleQueryStream } from '@/query/index'
import { createClient } from '@/lib/supabase-server'
import { cacheGet } from '@/lib/query-cache'
import { POST } from '../query/route'
import { USER_LIMIT, WINDOW_MS } from '@/lib/rate-limit-constants'
import { makeChainable } from '@/query/__tests__/helpers'

const MOCK_INTENT = { format: 'modern' as const, question_type: 'metagame' as const, archetype: null, archetype_b: null, opponent_archetype: null, card: null, card_mentions: [] as string[], timeframe_days: 90 as const }
const MOCK_DATA = { format: 'modern', window_days: 90, tournaments_count: 1, top_decks: [], card_info: null, card_glossary: [], article_chunks: [], confidence: 'HIGH' as const }

async function* fakeStream(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk
}

function makeReq(body: unknown) {
  return {
    json: () => Promise.resolve(body),
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

let mockUpsert: ReturnType<typeof vi.fn>
let mockFrom: ReturnType<typeof vi.fn>
let mockSupabase: Record<string, unknown>

function setupMocks(opts: {
  user: { id: string } | null
  oracleRow: { count: number; window_start: string } | null
}) {
  const oracleChain = makeChainable(
    { data: opts.oracleRow, error: null },
    { data: opts.oracleRow, error: opts.oracleRow ? null : { message: 'not found' } },
  )

  mockUpsert = vi.fn().mockResolvedValue({ error: null })

  mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'oracle_queries') {
      return { ...oracleChain, upsert: mockUpsert }
    }
    return makeChainable({ data: [], error: null })
  })

  mockSupabase = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: mockFrom,
  }

  vi.mocked(createClient).mockResolvedValue(mockSupabase as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(cacheGet).mockReturnValue(null)
  vi.mocked(handleQueryStream).mockResolvedValue({
    intent: MOCK_INTENT,
    data: MOCK_DATA,
    stream: fakeStream(['answer']),
  })
})

describe('POST /api/query rate limiting', () => {
  it('anon user gets tier=anon with remaining=null, resets_at=null', async () => {
    setupMocks({ user: null, oracleRow: null })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = events[0].data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.tier).toBe('anon')
    expect(rl.remaining).toBeNull()
    expect(rl.resets_at).toBeNull()
  })

  it('authed user with no existing row gets remaining = USER_LIMIT - 1', async () => {
    setupMocks({ user: { id: 'u1' }, oracleRow: null })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = events[0].data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.tier).toBe('user')
    expect(rl.remaining).toBe(USER_LIMIT - 1)
    expect(rl.resets_at).toBeTruthy()
  })

  it('authed user with no existing row upserts count=1 with new window_start', async () => {
    setupMocks({ user: { id: 'u1' }, oracleRow: null })

    const res = await POST(makeReq({ query: 'test' }))
    await res.text() // drain stream so upsert fires

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', count: 1 }),
      { onConflict: 'user_id' },
    )
  })

  it('authed user with active window (count=5) gets remaining=4', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString() // 1h ago
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: 5, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = events[0].data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.remaining).toBe(USER_LIMIT - 5 - 1)
  })

  it('authed user with active window upserts count+1 with same window_start', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: 5, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    await res.text()

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', count: 6, window_start: windowStart }),
      { onConflict: 'user_id' },
    )
  })

  it('authed user with expired window (>24h) is treated as fresh', async () => {
    const expiredStart = new Date(Date.now() - WINDOW_MS - 1000).toISOString() // 24h + 1s ago
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: 8, window_start: expiredStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const events = await readSSEEvents(res)
    const meta = events[0].data as Record<string, unknown>
    const rl = meta.rate_limit as Record<string, unknown>

    expect(rl.remaining).toBe(USER_LIMIT - 1)
  })

  it('authed user with expired window upserts count=1 with new window_start', async () => {
    const expiredStart = new Date(Date.now() - WINDOW_MS - 1000).toISOString()
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: 8, window_start: expiredStart } })

    const res = await POST(makeReq({ query: 'test' }))
    await res.text()

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', count: 1 }),
      { onConflict: 'user_id' },
    )
    // window_start should be recent, not the expired one
    const upsertArg = mockUpsert.mock.calls[0][0]
    const upsertedStart = new Date(upsertArg.window_start).getTime()
    expect(Math.abs(upsertedStart - Date.now())).toBeLessThan(5000)
  })

  it('returns 429 when authed user is at the limit', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: USER_LIMIT, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe('rate_limit_exceeded')
    expect(body.rate_limit.remaining).toBe(0)
    expect(body.rate_limit.tier).toBe('user')
  })

  it('429 resets_at is window_start + 24h', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: USER_LIMIT, window_start: windowStart } })

    const res = await POST(makeReq({ query: 'test' }))
    const body = await res.json()

    const expected = new Date(new Date(windowStart).getTime() + WINDOW_MS).toISOString()
    expect(body.rate_limit.resets_at).toBe(expected)
  })

  it('anon user does not trigger oracle_queries lookup or upsert', async () => {
    setupMocks({ user: null, oracleRow: null })

    const res = await POST(makeReq({ query: 'test' }))
    await res.text()

    expect(mockFrom).not.toHaveBeenCalledWith('oracle_queries')
    expect(mockUpsert).not.toHaveBeenCalled()
  })
})
