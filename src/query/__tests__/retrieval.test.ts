import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeChainable, DECK_FIXTURE, CARD_FIXTURE, INTENT_FIXTURE } from './helpers.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))
vi.mock('../../lib/voyage.js', () => ({ embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) }))

import { supabase } from '../../lib/supabase.js'
import { embed } from '../../lib/voyage.js'
import { retrieveContext, fetchRelevantArticles } from '../retrieval.js'

const originalEnv = { ...process.env }
beforeEach(() => { vi.resetAllMocks() })
afterEach(() => { process.env = { ...originalEnv } })

describe('retrieveContext', () => {
  it('returns top decks shaped as DeckSummary[]', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [DECK_FIXTURE], error: null })
    )
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: [], error: null } as never) // lookup_card_prices
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never) // resolveConfidence

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.format).toBe('modern')
    expect(result.window_days).toBe(90)
    expect(result.top_decks).toHaveLength(1)
    expect(result.top_decks[0].pilot).toBe('gerry_t')
    expect(result.top_decks[0].placement).toBe(1)
    expect(result.top_decks[0].mainboard).toContainEqual({ name: 'Lightning Bolt', qty: 4 })
    expect(result.top_decks[0].sideboard).toContainEqual({ name: 'Leyline of Sanctity', qty: 2 })
  })

  it('reports the correct tournaments_count from distinct tournament names', async () => {
    const twoTournaments = [
      { ...DECK_FIXTURE, tournaments: { ...DECK_FIXTURE.tournaments, name: 'Event A' } },
      { ...DECK_FIXTURE, pilot: 'bob', placement: 2, tournaments: { ...DECK_FIXTURE.tournaments, name: 'Event B' } },
    ]
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: twoTournaments, error: null })
    )
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: [], error: null } as never) // lookup_card_prices
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never) // resolveConfidence

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.tournaments_count).toBe(2)
  })

  it('returns an empty top_decks list when the DB has no results', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [], error: null })
    )

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.top_decks).toHaveLength(0)
    expect(result.tournaments_count).toBe(0)
  })

  it('includes card_info when intent has a card', async () => {
    // from() calls: fetchTopDecks (decks), fetchCardInfo (cards ilike)
    // rpc() calls: lookup_card_prices, count_card_appearances, resolveConfidence (metagame_snapshots)
    vi.mocked(supabase.from)
      .mockImplementationOnce(() => makeChainable({ data: [DECK_FIXTURE], error: null }))  // fetchTopDecks: decks
      .mockImplementationOnce(() => makeChainable(                                          // fetchCardInfo: cards (ilike, maybeSingle)
        { data: [], error: null },
        { data: CARD_FIXTURE, error: null },
      ))
      .mockImplementation(() => makeChainable({ data: [], error: null }))                   // DFC fallback + resolveConfidence

    vi.mocked(supabase.rpc)
      .mockResolvedValueOnce({ data: 17, error: null } as never)                           // count_card_appearances (runs in parallel with fetchTopDecks)
      .mockResolvedValueOnce({ data: [], error: null } as never)                           // lookup_card_prices (attachDeckCosts)

    const intent = { ...INTENT_FIXTURE, question_type: 'card_question' as const, card: 'Lightning Bolt' }
    const result = await retrieveContext(intent)

    expect(result.card_info).not.toBeNull()
    expect(result.card_info?.name).toBe('Lightning Bolt')
    expect(result.card_info?.appearances).toBe(17)
    expect(result.card_info?.oracle_text).toContain('3 damage')
  })

  it('returns null card_info when intent has no card', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [], error: null })
    )

    const result = await retrieveContext(INTENT_FIXTURE)  // INTENT_FIXTURE.card is null

    expect(result.card_info).toBeNull()
  })

  it('throws when the decks query returns an error', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: null, error: { message: 'connection timeout' } })
    )

    await expect(retrieveContext(INTENT_FIXTURE)).rejects.toThrow('connection timeout')
  })

  it('populates card_glossary from deck card names', async () => {
    const cardData = [
      { name: 'Lightning Bolt', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.' },
      { name: 'Goblin Guide', mana_cost: '{R}', type_line: 'Creature — Goblin Scout', oracle_text: 'Haste' },
      { name: 'Leyline of Sanctity', mana_cost: '{2}{W}{W}', type_line: 'Enchantment', oracle_text: 'You have hexproof.' },
    ]
    vi.mocked(supabase.from)
      .mockImplementationOnce(() => makeChainable({ data: [DECK_FIXTURE], error: null }))  // fetchTopDecks
      .mockImplementation(() => makeChainable({ data: cardData, error: null }))             // fetchCardGlossary + resolveConfidence (resolveConfidence falls through on missing .confidence)

    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: [], error: null } as never)   // lookup_card_prices

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.card_glossary).toHaveLength(3)
    expect(result.card_glossary.map(c => c.name).sort()).toEqual(['Goblin Guide', 'Leyline of Sanctity', 'Lightning Bolt'])
  })

  it('excludes cards with null oracle_text from glossary', async () => {
    // Use a deck with only one card so we can control exactly what's missing
    const singleCardDeck = {
      ...DECK_FIXTURE,
      raw_list: {
        mainboard: [{ name: 'Mountain', qty: 4 }],
        sideboard: [{ name: 'Lightning Bolt', qty: 4 }],
      },
    }
    const cardData = [
      { name: 'Lightning Bolt', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.' },
      { name: 'Mountain', mana_cost: null, type_line: 'Basic Land — Mountain', oracle_text: null },
    ]
    vi.mocked(supabase.from)
      .mockImplementationOnce(() => makeChainable({ data: [singleCardDeck], error: null }))
      .mockImplementation(() => makeChainable({ data: cardData, error: null }))

    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: [], error: null } as never)

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.card_glossary).toHaveLength(1)
    expect(result.card_glossary[0].name).toBe('Lightning Bolt')
  })

  it('returns empty glossary when no decks returned', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [], error: null })
    )

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.card_glossary).toEqual([])
  })

  it('returns empty glossary on DB error (graceful degradation)', async () => {
    vi.mocked(supabase.from)
      .mockImplementationOnce(() => makeChainable({ data: [DECK_FIXTURE], error: null }))
      .mockImplementationOnce(() => makeChainable({ data: null, error: { message: 'cards table error' } }))
      .mockImplementation(() => makeChainable({ data: [], error: null }))

    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: [], error: null } as never)
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as never)

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.card_glossary).toEqual([])
  })

  it('returns article_chunks on RetrievedData when RPC succeeds', async () => {
    process.env.VOYAGE_API_KEY = 'test-key'
    vi.mocked(embed).mockResolvedValue([[0.1, 0.2, 0.3]])
    const articleRpcData = [{
      chunk_id: 'c1', article_id: 'a1', chunk_index: 0,
      content: 'Burn is great right now',
      archetypes: ['Burn'], cards_mentioned: ['Lightning Bolt'],
      title: 'Burn Guide', author: 'Frank Karsten',
      published_at: '2026-02-15T00:00:00Z', source: 'MTGGoldfish',
      similarity: 0.9,
    }]

    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [DECK_FIXTURE], error: null })
    )
    vi.mocked(supabase.rpc).mockImplementation((fn: string) => {
      if (fn === 'match_article_chunks') return Promise.resolve({ data: articleRpcData, error: null }) as never
      if (fn === 'lookup_card_prices') return Promise.resolve({ data: [], error: null }) as never
      return Promise.resolve({ data: null, error: null }) as never
    })

    // Use base intent (archetype: null) to avoid resolveArchetypeIds calling embed concurrently
    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.article_chunks).toHaveLength(1)
    expect(result.article_chunks[0].title).toBe('Burn Guide')
    expect(result.article_chunks[0].author).toBe('Frank Karsten')
  })

  it('returns empty article_chunks when VOYAGE_API_KEY not set', async () => {
    delete process.env.VOYAGE_API_KEY

    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [DECK_FIXTURE], error: null })
    )
    vi.mocked(supabase.rpc)
      .mockResolvedValueOnce({ data: [], error: null } as never)  // lookup_card_prices
      .mockResolvedValueOnce({ data: null, error: null } as never) // resolveConfidence

    const result = await retrieveContext(INTENT_FIXTURE)

    expect(result.article_chunks).toEqual([])
  })

  it('merges article cards_mentioned into card glossary additionalNames', async () => {
    process.env.VOYAGE_API_KEY = 'test-key'
    vi.mocked(embed).mockResolvedValue([[0.1, 0.2, 0.3]])
    const articleRpcData = [{
      chunk_id: 'c1', article_id: 'a1', chunk_index: 0,
      content: 'Eidolon is key',
      archetypes: [], cards_mentioned: ['Eidolon of the Great Revel'],
      title: 'Guide', author: null,
      published_at: '2026-02-15T00:00:00Z', source: 'MTGGoldfish',
      similarity: 0.9,
    }]

    const cardData = [
      { name: 'Lightning Bolt', mana_cost: '{R}', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.' },
      { name: 'Goblin Guide', mana_cost: '{R}', type_line: 'Creature — Goblin Scout', oracle_text: 'Haste' },
      { name: 'Leyline of Sanctity', mana_cost: '{2}{W}{W}', type_line: 'Enchantment', oracle_text: 'You have hexproof.' },
      { name: 'Eidolon of the Great Revel', mana_cost: '{R}{R}', type_line: 'Enchantment Creature', oracle_text: 'Whenever a player casts a spell with mana value 3 or less, Eidolon deals 2 damage to that player.' },
    ]

    vi.mocked(supabase.from)
      .mockImplementationOnce(() => makeChainable({ data: [DECK_FIXTURE], error: null }))  // fetchTopDecks
      .mockImplementation(() => makeChainable({ data: cardData, error: null }))             // fetchCardGlossary

    vi.mocked(supabase.rpc).mockImplementation((fn: string) => {
      if (fn === 'match_article_chunks') return Promise.resolve({ data: articleRpcData, error: null }) as never
      if (fn === 'match_archetypes') return Promise.resolve({ data: [], error: null }) as never
      if (fn === 'lookup_card_prices') return Promise.resolve({ data: [], error: null }) as never
      return Promise.resolve({ data: null, error: null }) as never
    })

    const intent = { ...INTENT_FIXTURE, archetype: 'Burn' }
    const result = await retrieveContext(intent)

    const glossaryNames = result.card_glossary.map(c => c.name)
    expect(glossaryNames).toContain('Eidolon of the Great Revel')
  })
})
