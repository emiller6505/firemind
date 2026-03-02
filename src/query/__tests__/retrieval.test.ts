import { vi, describe, it, expect, beforeEach } from 'vitest'
import { makeChainable, DECK_FIXTURE, CARD_FIXTURE, INTENT_FIXTURE } from './helpers.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))

import { supabase } from '../../lib/supabase.js'
import { retrieveContext } from '../retrieval.js'

beforeEach(() => { vi.resetAllMocks() })

describe('retrieveContext', () => {
  it('returns top decks shaped as DeckSummary[]', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeChainable({ data: [DECK_FIXTURE], error: null })
    )

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
    // Call order: from('decks'), from('cards' ilike), from('cards' prices), from('metagame_snapshots')
    // rpc('count_card_appearances') is called once for the card lookup
    vi.mocked(supabase.from)
      .mockImplementationOnce(() => makeChainable({ data: [DECK_FIXTURE], error: null }))  // fetchTopDecks: decks
      .mockImplementationOnce(() => makeChainable(                                          // fetchCardInfo: cards (ilike, maybeSingle)
        { data: [], error: null },
        { data: CARD_FIXTURE, error: null },
      ))
      .mockImplementationOnce(() => makeChainable({ data: [], error: null }))               // attachDeckCosts: cards prices
      .mockImplementationOnce(() => makeChainable({ data: null, error: null }))             // metagame_snapshots (resolveConfidence)

    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: 17, error: null } as never)      // count_card_appearances

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
})
