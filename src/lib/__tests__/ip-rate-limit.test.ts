import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkIpLimit, ANON_IP_LIMIT, _resetForTest } from '../ip-rate-limit'

beforeEach(() => {
  _resetForTest()
  vi.restoreAllMocks()
})

describe('checkIpLimit', () => {
  it('allows a fresh IP', () => {
    expect(checkIpLimit('1.2.3.4').allowed).toBe(true)
  })

  it('allows up to ANON_IP_LIMIT requests', () => {
    for (let i = 0; i < ANON_IP_LIMIT; i++) {
      expect(checkIpLimit('1.2.3.4').allowed).toBe(true)
    }
  })

  it('blocks request #21', () => {
    for (let i = 0; i < ANON_IP_LIMIT; i++) {
      checkIpLimit('1.2.3.4')
    }
    expect(checkIpLimit('1.2.3.4').allowed).toBe(false)
  })

  it('resets after 24h window expires', () => {
    for (let i = 0; i < ANON_IP_LIMIT; i++) {
      checkIpLimit('1.2.3.4')
    }
    expect(checkIpLimit('1.2.3.4').allowed).toBe(false)

    const realNow = Date.now
    Date.now = () => realNow() + 24 * 60 * 60 * 1000 + 1
    expect(checkIpLimit('1.2.3.4').allowed).toBe(true)
    Date.now = realNow
  })

  it('evicts expired buckets at MAX_BUCKETS cap', () => {
    // Fill with 50_000 expired entries by manipulating time
    const realNow = Date.now
    const baseTime = realNow()

    Date.now = () => baseTime
    for (let i = 0; i < 50_000; i++) {
      checkIpLimit(`expired-${i}`)
    }

    // Move time forward past window so all are expired
    Date.now = () => baseTime + 24 * 60 * 60 * 1000 + 1

    // This should trigger eviction and still work
    expect(checkIpLimit('new-ip').allowed).toBe(true)
    Date.now = realNow
  })
})
