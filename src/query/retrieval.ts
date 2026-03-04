import { supabase } from '../lib/supabase'
import type { Trace } from '../lib/trace'
import type { Intent } from './intent'

// Voyage embeddings are optional — only used if VOYAGE_API_KEY is set
async function resolveArchetypeIds(archetypes: string[], format: string | null): Promise<string[] | null> {
  if (!process.env.VOYAGE_API_KEY || !format) return null
  try {
    const { embed } = await import('../lib/voyage')
    const [vector] = await embed([archetypes.join(' ')])
    const { data, error } = await supabase.rpc('match_archetypes', {
      query_embedding: JSON.stringify(vector),
      format_filter: format,
      match_count: archetypes.length * 2,
    })
    if (error || !data?.length) return null
    return (data as { id: string; similarity: number }[])
      .filter(r => r.similarity >= 0.7)
      .map(r => r.id)
  } catch {
    return null
  }
}

export interface DeckSummary {
  pilot: string
  placement: number | null
  tournament_name: string
  tournament_date: string
  tier: string | null
  archetype: string | null
  mainboard: { name: string; qty: number }[]
  sideboard: { name: string; qty: number }[]
  deck_cost_usd: number | null
  deck_cost_tix: number | null
}

export interface CardInfo {
  name: string
  oracle_text: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  appearances: number  // count of recent deck_cards rows
}

export interface RetrievedData {
  format: string | null
  window_days: number
  tournaments_count: number
  top_decks: DeckSummary[]
  card_info: CardInfo | null
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY HIGH'
}

export async function retrieveContext(intent: Intent, trace?: Trace): Promise<RetrievedData> {
  const window_days = intent.timeframe_days
  const cutoff = new Date(Date.now() - window_days * 86_400_000).toISOString().split('T')[0]

  const time = trace
    ? <T>(name: string, fn: () => Promise<T>) => trace.time(name, fn)
    : <T>(_: string, fn: () => Promise<T>) => fn()

  // For "against X" queries, fetch X's decklists so the LLM knows what threats to answer
  const archetypeForRetrieval = intent.archetype ?? intent.opponent_archetype
  const [rawDecks, cardInfo] = await Promise.all([
    time('fetchTopDecks', () => fetchTopDecks(intent.format, cutoff, archetypeForRetrieval, intent.archetype_b)),
    time('fetchCardInfo', () => intent.card ? fetchCardInfo(intent.card, intent.format, cutoff) : Promise.resolve(null)),
  ])

  const tournaments_count = new Set(rawDecks.map(d => d.tournament_name)).size
  const [topDecks, confidence] = await Promise.all([
    time('attachDeckCosts', () => attachDeckCosts(rawDecks)),
    time('resolveConfidence', () => resolveConfidence(intent.format, cutoff, rawDecks.length)),
  ])

  return { format: intent.format, window_days, tournaments_count, top_decks: topDecks, card_info: cardInfo, confidence }
}

// Pull the best confidence from metagame_snapshots for this format/window.
// Falls back to a count-based label if snapshots haven't been computed yet.
async function resolveConfidence(
  format: string | null,
  cutoff: string,
  deckCount: number,
): Promise<'LOW' | 'MEDIUM' | 'HIGH' | 'VERY HIGH'> {
  if (format) {
    const { data } = await supabase
      .from('metagame_snapshots')
      .select('confidence, sample_size')
      .eq('format', format)
      .gte('window_start', cutoff)
      .order('sample_size', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (data?.confidence) return data.confidence as 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY HIGH'
  }

  // Fallback when snapshots not yet available
  if (deckCount >= 20) return 'VERY HIGH'
  if (deckCount >= 10) return 'HIGH'
  if (deckCount >= 5) return 'MEDIUM'
  return 'LOW'
}

type RawDeck = Omit<DeckSummary, 'deck_cost_usd' | 'deck_cost_tix'>

async function fetchTopDecks(
  format: string | null,
  cutoff: string,
  archetype: string | null,
  archetype_b: string | null,
): Promise<RawDeck[]> {
  const archetypeHints = [archetype, archetype_b].filter(Boolean) as string[]

  // If archetypes are mentioned, try to resolve them to IDs via vector search first.
  // If that fails (no VOYAGE_API_KEY or no embeddings yet), fall through to keyword heuristic below.
  let archetypeIds: string[] | null = null
  if (archetypeHints.length > 0) {
    archetypeIds = await resolveArchetypeIds(archetypeHints, format)
  }

  let query = supabase
    .from('decks')
    .select(`
      pilot,
      placement,
      raw_list,
      tournaments!inner (
        name,
        date,
        format,
        tier
      ),
      deck_archetypes (
        confidence,
        archetypes (
          name
        )
      )
    `)
    .gte('tournaments.date', cutoff)
    .not('placement', 'is', null)
    .lte('placement', 32)
    .order('placement', { ascending: true })
    .limit(500)

  if (format) query = query.eq('tournaments.format', format)

  // When we have resolved archetype IDs, filter decks via deck_archetypes join
  if (archetypeIds && archetypeIds.length > 0) {
    const { data: archetypeDecks } = await supabase
      .from('deck_archetypes')
      .select('deck_id')
      .in('archetype_id', archetypeIds)
    const deckIds = (archetypeDecks ?? []).map(r => r.deck_id)
    if (deckIds.length > 0) query = query.in('id', deckIds)
  }

  const { data, error } = await query
  if (error) throw new Error(`Deck retrieval error: ${error.message}`)

  const allDecks = (data ?? []).map(row => {
    const t = row.tournaments as unknown as { name: string; date: string; format: string; tier: string | null }
    const rawList = row.raw_list as { mainboard: { name: string; qty: number }[]; sideboard: { name: string; qty: number }[] } | null
    const deckArchetypes = row.deck_archetypes as unknown as Array<{ confidence: number; archetypes: { name: string } | null }> | null
    const topArchetype = (deckArchetypes ?? [])
      .filter(da => da.archetypes?.name)
      .sort((a, b) => b.confidence - a.confidence)[0]
    return {
      pilot: row.pilot ?? 'Unknown',
      placement: row.placement,
      tournament_name: t.name,
      tournament_date: t.date,
      tier: t.tier,
      archetype: topArchetype?.archetypes?.name ?? null,
      mainboard: rawList?.mainboard ?? [],
      sideboard: rawList?.sideboard ?? [],
    }
  })

  // Cap at top 8 per tournament so every event contributes equally regardless of
  // how many total tournaments are in the window. Sort by recency then placement.
  const TOP_PER_TOURNAMENT = 8
  const byTournament = new Map<string, typeof allDecks>()
  for (const deck of allDecks) {
    const key = `${deck.tournament_name}||${deck.tournament_date}`
    if (!byTournament.has(key)) byTournament.set(key, [])
    byTournament.get(key)!.push(deck)
  }
  let decks: typeof allDecks = []
  for (const tDecks of byTournament.values()) {
    decks.push(...tDecks.slice(0, TOP_PER_TOURNAMENT))
  }
  // Most recent tournaments first, then by placement within each event
  decks.sort((a, b) =>
    b.tournament_date.localeCompare(a.tournament_date) ||
    (a.placement ?? 999) - (b.placement ?? 999)
  )

  // Fallback: keyword heuristic when vector search isn't available or returned nothing
  if (archetypeHints.length > 0 && archetypeIds === null) {
    decks = filterByArchetypeHint(decks, archetypeHints)
  }

  return decks
}

async function lookupPrices(names: string[]): Promise<{ name: string; usd: number | null; tix: number | null }[]> {
  // Uses lookup_card_prices RPC which does DISTINCT ON (name) in SQL.
  // This avoids the PostgREST row-limit issue where cards with many printings
  // (basic lands ~900 rows each) silently drop other names from the result set.
  const { data, error } = await supabase.rpc('lookup_card_prices', { p_names: names })
  if (error) console.warn(`[retrieval] lookup_card_prices failed: ${error.message}`)
  return (data as { name: string; usd: number | null; tix: number | null }[]) ?? []
}

async function attachDeckCosts(decks: RawDeck[]): Promise<DeckSummary[]> {
  if (decks.length === 0) return decks.map(d => ({ ...d, deck_cost_usd: null, deck_cost_tix: null }))

  const allNames = [...new Set(decks.flatMap(d => d.mainboard.map(c => c.name)))]
  const rows = await lookupPrices(allNames)

  if (rows.length === 0) console.warn('[retrieval] attachDeckCosts: no price data returned')

  const priceMap = new Map<string, { usd: number | null; tix: number | null }>()
  for (const row of rows) {
    priceMap.set(row.name, { usd: row.usd ?? null, tix: row.tix ?? null })
  }

  // Name mismatches between MTGO and Scryfall:
  // 1. DFC: MTGO uses front face ("Fable of the Mirror-Breaker"), Scryfall stores "Front // Back"
  // 2. Split cards: MTGO uses "/" ("Wear/Tear"), Scryfall uses " // " ("Wear // Tear")
  const missingNames = allNames.filter(n => !priceMap.has(n))
  if (missingNames.length > 0) {
    // Split card normalization: try "Name/Name" → "Name // Name"
    const splitNames = missingNames.filter(n => n.includes('/') && !n.includes(' // '))
    if (splitNames.length > 0) {
      const normalizedSplitNames = splitNames.map(n => n.replace('/', ' // '))
      const splitRows = await lookupPrices(normalizedSplitNames)
      for (const row of splitRows) {
        const originalName = splitNames[normalizedSplitNames.indexOf(row.name)]
        if (originalName) priceMap.set(originalName, { usd: row.usd ?? null, tix: row.tix ?? null })
      }
    }

    // DFC fallback: MTGO may use front-face or back-face names, Scryfall stores "Front // Back".
    // Try both "name // %" (front-face) and "% // name" (back-face) patterns.
    const stillMissing = missingNames.filter(n => !priceMap.has(n))
    if (stillMissing.length > 0) {
      const dfcResults = await Promise.all(
        stillMissing.map(async name => {
          const { data: front } = await supabase.from('cards').select('name, usd, tix').like('name', `${name} // %`).limit(10)
          if (front && front.length > 0) return front
          const { data: back } = await supabase.from('cards').select('name, usd, tix').like('name', `% // ${name}`).limit(10)
          return back ?? []
        })
      )
      for (let i = 0; i < stillMissing.length; i++) {
        const original = stillMissing[i]!
        for (const row of dfcResults[i]!) {
          if (!row.name?.includes(' // ')) continue
          const existing = priceMap.get(original)
          priceMap.set(original, {
            usd: existing?.usd ?? row.usd ?? null,
            tix: existing?.tix ?? row.tix ?? null,
          })
          break
        }
      }
    }
  }

  return decks.map(d => {
    let usdTotal = 0, tixTotal = 0, usdNames = 0, tixNames = 0
    for (const card of d.mainboard) {
      const p = priceMap.get(card.name)
      if (p?.usd != null) { usdTotal += card.qty * p.usd; usdNames++ }
      if (p?.tix != null) { tixTotal += card.qty * p.tix; tixNames++ }
    }
    const minCoverage = d.mainboard.length * 0.75
    return {
      ...d,
      deck_cost_usd: usdNames >= minCoverage ? Math.round(usdTotal * 100) / 100 : null,
      deck_cost_tix: tixNames >= minCoverage ? Math.round(tixTotal * 100) / 100 : null,
    }
  })
}

function filterByArchetypeHint(decks: RawDeck[], archetypes: string[]): RawDeck[] {
  const keywords = archetypes.flatMap(a => a.toLowerCase().split(/\s+/))

  // Match on the labeled archetype name (from deck_archetypes join), not card names.
  // "Burn" matches decks labeled "Burn" or "Mono-Red Burn"; "Murktide" matches "Izzet Murktide".
  const labeled = decks.filter(d =>
    d.archetype && keywords.some(kw => d.archetype!.toLowerCase().includes(kw))
  )
  if (labeled.length > 0) return labeled

  // No labeled archetypes yet (clustering hasn't run). Return the full list so the
  // LLM has real context to work with rather than an empty result set.
  return decks
}

async function fetchCardInfo(card: string, format: string | null, cutoff: string): Promise<CardInfo | null> {
  const { data: cardRow, error: cardErr } = await supabase
    .from('cards')
    .select('name, oracle_text, type_line, mana_cost, cmc')
    .ilike('name', card)
    .limit(1)
    .maybeSingle()

  if (cardErr || !cardRow) return null

  // count_card_appearances RPC does the join in SQL, avoiding unbounded .in() chains
  const { data: countData, error: countErr } = await supabase.rpc('count_card_appearances', {
    p_card_name:      cardRow.name,
    p_format:         format,
    p_cutoff:         cutoff,
    p_max_placement:  32,
  })
  if (countErr) console.warn(`[retrieval] count_card_appearances failed: ${countErr.message}`)

  return {
    name:        cardRow.name,
    oracle_text: cardRow.oracle_text,
    type_line:   cardRow.type_line,
    mana_cost:   cardRow.mana_cost,
    cmc:         cardRow.cmc,
    appearances: (countData as number | null) ?? 0,
  }
}
