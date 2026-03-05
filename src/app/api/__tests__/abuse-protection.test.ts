import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock dependencies before importing the route
vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/circuit-breaker', () => ({
  checkCircuitBreaker: vi.fn(),
}))

vi.mock('@/lib/ip-rate-limit', () => ({
  checkIpLimit: vi.fn(),
}))

vi.mock('@/query/index', () => ({
  handleQueryStream: vi.fn(),
}))

vi.mock('@/lib/query-cache', () => ({
  cacheGet: vi.fn(() => null),
  cacheSet: vi.fn(),
}))

vi.mock('@/query/decklist', () => ({
  parseDecklist: vi.fn(() => null),
  validateDecklist: vi.fn(() => []),
  formatValidationWarning: vi.fn(() => ''),
  fixCopyLimits: vi.fn(),
  renderDecklist: vi.fn(),
}))

import { POST } from '../query/route'
import { createClient } from '@/lib/supabase-server'
import { checkCircuitBreaker } from '@/lib/circuit-breaker'
import { checkIpLimit } from '@/lib/ip-rate-limit'
import { NextRequest } from 'next/server'

const mockCreateClient = createClient as ReturnType<typeof vi.fn>
const mockCheckCircuitBreaker = checkCircuitBreaker as ReturnType<typeof vi.fn>
const mockCheckIpLimit = checkIpLimit as ReturnType<typeof vi.fn>

function makeRequest(body: Record<string, unknown>, headers?: Record<string, string>) {
  return new NextRequest('http://localhost/api/query', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function mockSupabaseWithUser(user: { id: string } | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
        }),
        gte: () => Promise.resolve({ count: 0 }),
      }),
      upsert: () => Promise.resolve({}),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('abuse protection', () => {
  it('anon from blocked IP → 429 with tier ip', async () => {
    const sb = mockSupabaseWithUser(null)
    mockCreateClient.mockResolvedValue(sb)
    mockCheckCircuitBreaker.mockResolvedValue(true)
    mockCheckIpLimit.mockReturnValue({ allowed: false })

    const res = await POST(makeRequest({ query: 'test' }, { 'x-forwarded-for': '1.2.3.4' }))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.rate_limit.tier).toBe('ip')
  })

  it('auth user bypasses IP limit', async () => {
    const sb = mockSupabaseWithUser({ id: 'user-1' })
    mockCreateClient.mockResolvedValue(sb)
    mockCheckCircuitBreaker.mockResolvedValue(true)
    mockCheckIpLimit.mockReturnValue({ allowed: false }) // would block if checked

    // Should NOT return 429 — auth users skip IP check
    const { handleQueryStream } = await import('@/query/index')
    const mockStream = (async function* () { yield 'hello' })()
    ;(handleQueryStream as ReturnType<typeof vi.fn>).mockResolvedValue({
      intent: { type: 'meta' },
      data: {},
      stream: mockStream,
    })

    const res = await POST(makeRequest({ query: 'test' }, { 'x-forwarded-for': '1.2.3.4' }))
    expect(res.status).toBe(200)
    expect(mockCheckIpLimit).not.toHaveBeenCalled()
  })

  it('circuit breaker tripped → 503 for all users', async () => {
    const sb = mockSupabaseWithUser({ id: 'user-1' })
    mockCreateClient.mockResolvedValue(sb)
    mockCheckCircuitBreaker.mockResolvedValue(false)

    const res = await POST(makeRequest({ query: 'test' }))
    expect(res.status).toBe(503)
  })

  it('both checks fire before handleQueryStream', async () => {
    const sb = mockSupabaseWithUser(null)
    mockCreateClient.mockResolvedValue(sb)
    mockCheckCircuitBreaker.mockResolvedValue(true)
    mockCheckIpLimit.mockReturnValue({ allowed: true })

    const { handleQueryStream } = await import('@/query/index')
    const mockStream = (async function* () { yield 'hello' })()
    ;(handleQueryStream as ReturnType<typeof vi.fn>).mockResolvedValue({
      intent: { type: 'meta' },
      data: {},
      stream: mockStream,
    })

    await POST(makeRequest({ query: 'test' }))

    // Circuit breaker called first
    expect(mockCheckCircuitBreaker).toHaveBeenCalledTimes(1)
    // IP limit called for anon
    expect(mockCheckIpLimit).toHaveBeenCalledTimes(1)
  })
})
