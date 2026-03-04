import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ createClient: vi.fn() }))

import { createClient } from '@/lib/supabase-server'
import { GET } from '../query-status/route'
import { USER_LIMIT, WINDOW_MS } from '@/lib/rate-limit-constants'
import { makeChainable } from '@/query/__tests__/helpers'

let mockSupabase: Record<string, unknown>

function setupMocks(opts: {
  user: { id: string } | null
  oracleRow: { count: number; window_start: string } | null
}) {
  const oracleChain = makeChainable(
    { data: opts.oracleRow, error: null },
    { data: opts.oracleRow, error: opts.oracleRow ? null : { message: 'not found' } },
  )

  mockSupabase = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn().mockReturnValue(oracleChain),
  }

  vi.mocked(createClient).mockResolvedValue(mockSupabase as never)
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GET /api/query-status', () => {
  it('anon user gets remaining=null, resets_at=null', async () => {
    setupMocks({ user: null, oracleRow: null })

    const res = await GET()
    const body = await res.json()

    expect(body.remaining).toBeNull()
    expect(body.resets_at).toBeNull()
  })

  it('authed user with no row gets remaining=USER_LIMIT, resets_at=null', async () => {
    setupMocks({ user: { id: 'u1' }, oracleRow: null })

    const res = await GET()
    const body = await res.json()

    expect(body.remaining).toBe(USER_LIMIT)
    expect(body.resets_at).toBeNull()
  })

  it('authed user with active window gets correct remaining and resets_at', async () => {
    const windowStart = new Date(Date.now() - 1000 * 60 * 60).toISOString() // 1h ago
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: 3, window_start: windowStart } })

    const res = await GET()
    const body = await res.json()

    expect(body.remaining).toBe(USER_LIMIT - 3)
    const expectedResets = new Date(new Date(windowStart).getTime() + WINDOW_MS).toISOString()
    expect(body.resets_at).toBe(expectedResets)
  })

  it('authed user with expired window gets remaining=USER_LIMIT, resets_at=null', async () => {
    const expiredStart = new Date(Date.now() - WINDOW_MS - 1000).toISOString()
    setupMocks({ user: { id: 'u1' }, oracleRow: { count: 8, window_start: expiredStart } })

    const res = await GET()
    const body = await res.json()

    expect(body.remaining).toBe(USER_LIMIT)
    expect(body.resets_at).toBeNull()
  })
})
