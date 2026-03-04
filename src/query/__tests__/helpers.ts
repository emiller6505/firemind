// Chainable Supabase query builder mock.
// Every filter method returns the same chain; the chain is thenable so `await chain`
// resolves with `chainResult`. `.single()` resolves with `singleResult` (defaults to chainResult).

type PgResult = { data: unknown; error: { message: string } | null; count?: number }

export function makeChainable(chainResult: PgResult, singleResult?: PgResult): ReturnType<typeof Object.create> {
  const chain: Record<string, unknown> = {
    single: () => Promise.resolve(singleResult ?? chainResult),
    maybeSingle: () => Promise.resolve(singleResult ?? chainResult),
    then: (resolve: (v: PgResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(chainResult).then(resolve, reject),
  }
  for (const m of ['select', 'update', 'upsert', 'gte', 'lte', 'eq', 'not', 'order', 'limit', 'in', 'ilike', 'like', 'delete']) {
    chain[m] = () => chain
  }
  return chain
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Raw DB row shape (what Supabase returns from the decks table with joined tournament)
export const DECK_FIXTURE = {
  pilot: 'gerry_t',
  placement: 1,
  raw_list: {
    mainboard: [
      { name: 'Lightning Bolt', qty: 4 },
      { name: 'Goblin Guide', qty: 4 },
    ],
    sideboard: [{ name: 'Leyline of Sanctity', qty: 2 }],
  },
  tournaments: {
    name: 'Modern Challenge 32',
    date: '2026-02-28',
    format: 'modern',
    tier: 'challenge',
  },
  deck_archetypes: [],
}

// DeckSummary shape (what retrieveContext maps DB rows into — used by assembleContext)
export const DECK_SUMMARY_FIXTURE = {
  pilot: 'gerry_t',
  placement: 1,
  tournament_name: 'Modern Challenge 32',
  tournament_date: '2026-02-28',
  tier: 'challenge',
  archetype: 'Burn',
  mainboard: [
    { name: 'Lightning Bolt', qty: 4 },
    { name: 'Goblin Guide', qty: 4 },
  ],
  sideboard: [{ name: 'Leyline of Sanctity', qty: 2 }],
  deck_cost_usd: null,
  deck_cost_tix: null,
}

export const CARD_FIXTURE = {
  name: 'Lightning Bolt',
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  type_line: 'Instant',
  mana_cost: '{R}',
  cmc: 1,
}

export const ARTICLE_CHUNK_FIXTURE = {
  title: 'Sideboard Guide: Modern Burn',
  author: 'Frank Karsten',
  source: 'MTGGoldfish',
  published_at: '2026-02-15T00:00:00Z',
  content: 'Against control, you want to board in Eidolon of the Great Revel and cut Searing Blaze.',
  cards_mentioned: ['Eidolon of the Great Revel', 'Searing Blaze'],
}

export const INTENT_FIXTURE = {
  format: 'modern' as const,
  question_type: 'metagame' as const,
  archetype: null,
  archetype_b: null,
  opponent_archetype: null,
  card: null,
  card_mentions: [] as string[],
  timeframe_days: 90 as const,
}
