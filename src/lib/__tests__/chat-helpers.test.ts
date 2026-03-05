import { describe, it, expect } from 'vitest'
import { remainingColor, counterReady, showGoSpikeLink } from '../chat-helpers'

describe('remainingColor', () => {
  it('returns text-ash for 3+ remaining', () => {
    expect(remainingColor(3)).toBe('text-ash')
    expect(remainingColor(10)).toBe('text-ash')
    expect(remainingColor(100)).toBe('text-ash')
  })

  it('returns text-gold for exactly 2 remaining', () => {
    expect(remainingColor(2)).toBe('text-gold')
  })

  it('returns text-flame for 1 remaining', () => {
    expect(remainingColor(1)).toBe('text-flame')
  })

  it('returns text-flame for 0 remaining', () => {
    expect(remainingColor(0)).toBe('text-flame')
  })
})

describe('counterReady', () => {
  it('anon with 0 queries is NOT ready (no counter before first query)', () => {
    expect(counterReady(true, 0, null)).toBe(false)
  })

  it('anon with 1+ queries IS ready', () => {
    expect(counterReady(true, 1, null)).toBe(true)
    expect(counterReady(true, 3, null)).toBe(true)
  })

  it('anon ignores remaining param', () => {
    expect(counterReady(true, 0, 5)).toBe(false)
    expect(counterReady(true, 2, null)).toBe(true)
  })

  it('authed user is ready when remaining is fetched (non-null)', () => {
    expect(counterReady(false, 0, 10)).toBe(true)
    expect(counterReady(false, 0, 0)).toBe(true)
  })

  it('authed user is NOT ready when remaining is null (still loading)', () => {
    expect(counterReady(false, 0, null)).toBe(false)
  })
})

describe('showGoSpikeLink', () => {
  it('hidden at 2+ remaining', () => {
    expect(showGoSpikeLink(2)).toBe(false)
    expect(showGoSpikeLink(5)).toBe(false)
    expect(showGoSpikeLink(10)).toBe(false)
  })

  it('visible at 1 remaining', () => {
    expect(showGoSpikeLink(1)).toBe(true)
  })

  it('visible at 0 remaining', () => {
    expect(showGoSpikeLink(0)).toBe(true)
  })
})
