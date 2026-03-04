import { describe, it, expect } from 'vitest'
import { assembleContext } from '../assemble.js'
import { INTENT_FIXTURE, DECK_SUMMARY_FIXTURE, CARD_FIXTURE, ARTICLE_CHUNK_FIXTURE } from './helpers.js'
import type { RetrievedData } from '../retrieval.js'

function makeData(overrides: Partial<RetrievedData> = {}): RetrievedData {
  return {
    format: 'modern',
    window_days: 90,
    tournaments_count: 2,
    top_decks: [DECK_SUMMARY_FIXTURE],
    card_info: null,
    card_glossary: [],
    article_chunks: [],
    confidence: 'HIGH',
    ...overrides,
  }
}

describe('assembleContext', () => {
  it('includes format and window size in the header', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData())

    expect(ctx).toContain('modern')
    expect(ctx).toContain('90')
    expect(ctx).toContain('2')  // tournaments_count
  })

  it('renders deck pilot and placement', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData())

    expect(ctx).toContain('gerry_t')
    expect(ctx).toContain('1')  // placement
    expect(ctx).toContain('Lightning Bolt')
  })

  it('includes sideboard when present', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData())

    expect(ctx).toContain('Sideboard')
    expect(ctx).toContain('Leyline of Sanctity')
  })

  it('shows a no-data message when top_decks is empty', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({ top_decks: [] }))

    expect(ctx).toContain('No deck data found')
  })

  it('includes card info block when card_info is present', () => {
    const ctx = assembleContext(
      { ...INTENT_FIXTURE, question_type: 'card_question', card: 'Lightning Bolt' },
      makeData({ card_info: { ...CARD_FIXTURE, appearances: 42 } }),
    )

    expect(ctx).toContain('Lightning Bolt')
    expect(ctx).toContain('{R}')
    expect(ctx).toContain('42')  // appearances
    expect(ctx).toContain('3 damage')  // oracle_text excerpt
  })

  it('omits card info section when card_info is null', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({ card_info: null }))

    expect(ctx).not.toContain('Card:')
  })

  it('includes opponent framing note when opponent_archetype is set', () => {
    const ctx = assembleContext(
      { ...INTENT_FIXTURE, opponent_archetype: 'Tron' },
      makeData(),
    )

    expect(ctx).toContain('Query Framing')
    expect(ctx).toContain('AGAINST Tron')
    expect(ctx).toContain('NOT playing Tron')
  })

  it('omits framing note when opponent_archetype is null', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData())

    expect(ctx).not.toContain('Query Framing')
  })

  it('renders Card Reference when glossary is non-empty', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({
      card_glossary: [
        { name: 'Lightning Bolt', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.' },
      ],
    }))

    expect(ctx).toContain('=== Card Reference ===')
    expect(ctx).toContain('Lightning Bolt [{R}] — Instant: Lightning Bolt deals 3 damage to any target.')
  })

  it('omits Card Reference when glossary is empty', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({ card_glossary: [] }))

    expect(ctx).not.toContain('Card Reference')
  })

  it('renders Card Reference before Top Decks', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({
      card_glossary: [
        { name: 'Goblin Guide', mana_cost: '{R}', type_line: 'Creature — Goblin Scout', oracle_text: 'Haste\nWhenever Goblin Guide attacks, defending player reveals the top card of their library. If it\'s a land card, that player puts it into their hand.' },
      ],
    }))

    const refIdx = ctx.indexOf('Card Reference')
    const decksIdx = ctx.indexOf('Top Decks')
    expect(refIdx).toBeGreaterThan(-1)
    expect(decksIdx).toBeGreaterThan(-1)
    expect(refIdx).toBeLessThan(decksIdx)
  })

  it('renders Expert Analysis when article_chunks present', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({
      article_chunks: [ARTICLE_CHUNK_FIXTURE],
    }))

    expect(ctx).toContain('=== Expert Analysis ===')
    expect(ctx).toContain('MTGGoldfish')
    expect(ctx).toContain('"Sideboard Guide: Modern Burn"')
    expect(ctx).toContain('by Frank Karsten')
    expect(ctx).toContain('2026-02-15')
    expect(ctx).toContain('Eidolon of the Great Revel')
  })

  it('omits Expert Analysis when article_chunks is empty', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({ article_chunks: [] }))

    expect(ctx).not.toContain('Expert Analysis')
  })

  it('renders Expert Analysis before Top Decks', () => {
    const ctx = assembleContext(INTENT_FIXTURE, makeData({
      article_chunks: [ARTICLE_CHUNK_FIXTURE],
    }))

    const expertIdx = ctx.indexOf('Expert Analysis')
    const decksIdx = ctx.indexOf('Top Decks')
    expect(expertIdx).toBeGreaterThan(-1)
    expect(decksIdx).toBeGreaterThan(-1)
    expect(expertIdx).toBeLessThan(decksIdx)
  })
})
