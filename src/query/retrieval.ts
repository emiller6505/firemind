import { supabase } from '../lib/supabase'
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

export async function retrieveContext(intent: Intent): Promise<RetrievedData> {
  const window_days = intent.timeframe_days
  const cutoff = new Date(Date.now() - window_days * 86_400_000).toISOString().split('T')[0]

  const [rawDecks, cardInfo] = await Promise.all([
    fetchTopDecks(intent.format, cutoff, intent.archetype, intent.archetype_b),
    intent.card ? fetchCardInfo(intent.card, intent.format, cutoff) : Promise.resolve(null),
  ])

  const tournaments_count = new Set(rawDecks.map(d => d.tournament_name)).size
  const [topDecks, confidence] = await Promise.all([
    attachDeckCosts(rawDecks),
    resolveConfidence(intent.format, cutoff, rawDecks.length),
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
    .order('placement', { ascending: true })
    .limit(24)

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

  let decks = (data ?? []).map(row => {
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

  // Fallback: keyword heuristic when vector search isn't available or returned nothing
  if (archetypeHints.length > 0 && archetypeIds === null) {
    decks = filterByArchetypeHint(decks, archetypeHints)
  }

  return decks
}

async function fetchPriceChunk(names: string[]): Promise<{ name: string; usd: number | null; tix: number | null }[]> {
  const { data, error } = await supabase.from('cards').select('name, usd, tix').in('name', names)
  if (error) console.warn(`[retrieval] price chunk lookup failed: ${error.message}`)
  return data ?? []
}

async function attachDeckCosts(decks: RawDeck[]): Promise<DeckSummary[]> {
  if (decks.length === 0) return decks.map(d => ({ ...d, deck_cost_usd: null, deck_cost_tix: null }))

  const allNames = [...new Set(decks.flatMap(d => d.mainboard.map(c => c.name)))]
  // Chunk to stay well under PostgREST's ~8KB URL limit
  const CHUNK = 100
  const chunks: string[][] = []
  for (let i = 0; i < allNames.length; i += CHUNK) chunks.push(allNames.slice(i, i + CHUNK))
  const rows = (await Promise.all(chunks.map(fetchPriceChunk))).flat()

  if (rows.length === 0) console.warn('[retrieval] attachDeckCosts: no price data returned')

  const priceMap = new Map<string, { usd: number | null; tix: number | null }>()
  for (const row of rows) {
    priceMap.set(row.name, { usd: row.usd ?? null, tix: row.tix ?? null })
  }

  return decks.map(d => {
    let usdTotal = 0, tixTotal = 0, usdNames = 0, tixNames = 0
    for (const card of d.mainboard) {
      const p = priceMap.get(card.name)
      if (p?.usd != null) { usdTotal += card.qty * p.usd; usdNames++ }
      if (p?.tix != null) { tixTotal += card.qty * p.tix; tixNames++ }
    }
    // Require ≥75% of distinct mainboard card names to have prices.
    // Name-based coverage catches missing expensive cards (e.g. 4x fetch land = 1 name)
    // better than quantity-based coverage (4 copies counted as 4 of 60 quantities).
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
