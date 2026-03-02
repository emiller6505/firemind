import { supabase } from '../lib/supabase'

// Windows to compute snapshots for, in days
const WINDOWS = [30, 60, 90] as const

export async function computeSnapshots(format: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0]

  for (const windowDays of WINDOWS) {
    const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString().split('T')[0]
    await computeWindow(format, windowStart, today, windowDays)
  }
}

async function computeWindow(
  format: string,
  windowStart: string,
  windowEnd: string,
  windowDays: number,
): Promise<void> {
  // Fetch all archetype assignments for decks in this window
  // PostgREST can't do server-side GROUP BY, so we aggregate in JS
  const { data, error } = await supabase
    .from('deck_archetypes')
    .select(`
      archetype_id,
      decks!inner (
        placement,
        tournaments!inner (
          format,
          date,
          source
        )
      )
    `)
    .eq('method', 'jaccard')
    .eq('decks.tournaments.format', format)
    .gte('decks.tournaments.date', windowStart)
    .lte('decks.tournaments.date', windowEnd)

  if (error) throw new Error(`Snapshot fetch error: ${error.message}`)
  if (!data || data.length === 0) {
    console.log(`[snapshot] ${format} ${windowDays}d: no data`)
    return
  }

  // Aggregate by archetype_id
  const byArchetype = new Map<string, {
    top8Count: number
    totalEntries: number
    sources: Set<string>
  }>()

  for (const row of data) {
    const archetypeId = row.archetype_id
    const deck = row.decks as unknown as { placement: number | null; tournaments: { source: string } }
    const source = deck.tournaments.source
    const placement = deck.placement

    if (!byArchetype.has(archetypeId)) {
      byArchetype.set(archetypeId, { top8Count: 0, totalEntries: 0, sources: new Set() })
    }
    const agg = byArchetype.get(archetypeId)!
    agg.totalEntries++
    agg.sources.add(source)
    if (placement != null && placement <= 8) agg.top8Count++
  }

  const totalDecks = [...byArchetype.values()].reduce((sum, a) => sum + a.totalEntries, 0)

  // Compute prior window for trend_delta
  const priorEnd = new Date(new Date(windowStart).getTime() - 86_400_000).toISOString().split('T')[0]
  const priorStart = new Date(new Date(priorEnd).getTime() - windowDays * 86_400_000).toISOString().split('T')[0]
  const priorShares = await fetchMetaShares(format, priorStart, priorEnd)

  const rows = [...byArchetype.entries()].map(([archetypeId, agg]) => {
    const metaShare = totalDecks > 0 ? parseFloat(((agg.totalEntries / totalDecks) * 100).toFixed(2)) : 0
    const priorShare = priorShares.get(archetypeId) ?? null
    const trendDelta = priorShare != null ? parseFloat((metaShare - priorShare).toFixed(2)) : null

    return {
      format,
      window_start: windowStart,
      window_end: windowEnd,
      archetype_id: archetypeId,
      top8_count: agg.top8Count,
      total_entries: agg.totalEntries,
      meta_share: metaShare,
      trend_delta: trendDelta,
      sample_size: agg.totalEntries,
      confidence: confidenceLabel(agg.totalEntries, agg.sources.size),
      computed_at: new Date().toISOString(),
    }
  })

  // Delete stale snapshots for this window before inserting fresh ones
  await supabase
    .from('metagame_snapshots')
    .delete()
    .eq('format', format)
    .eq('window_start', windowStart)
    .eq('window_end', windowEnd)

  if (rows.length > 0) {
    const { error: insertErr } = await supabase.from('metagame_snapshots').insert(rows)
    if (insertErr) throw new Error(`Snapshot insert error: ${insertErr.message}`)
  }

  console.log(`[snapshot] ${format} ${windowDays}d: ${rows.length} archetypes, ${totalDecks} total decks`)
}

async function fetchMetaShares(
  format: string,
  windowStart: string,
  windowEnd: string,
): Promise<Map<string, number>> {
  const { data } = await supabase
    .from('deck_archetypes')
    .select(`
      archetype_id,
      decks!inner (
        tournaments!inner (format, date)
      )
    `)
    .eq('method', 'jaccard')
    .eq('decks.tournaments.format', format)
    .gte('decks.tournaments.date', windowStart)
    .lte('decks.tournaments.date', windowEnd)

  if (!data || data.length === 0) return new Map()

  const counts = new Map<string, number>()
  for (const row of data) counts.set(row.archetype_id, (counts.get(row.archetype_id) ?? 0) + 1)

  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const shares = new Map<string, number>()
  for (const [id, count] of counts) {
    shares.set(id, parseFloat(((count / total) * 100).toFixed(2)))
  }
  return shares
}

function confidenceLabel(sampleSize: number, sourceCount: number): string {
  // Weight: sample size (primary) + source diversity bonus
  const effective = sampleSize + (sourceCount > 1 ? 5 : 0) + (sourceCount > 2 ? 5 : 0)
  if (effective >= 20) return 'VERY HIGH'
  if (effective >= 10) return 'HIGH'
  if (effective >= 5) return 'MEDIUM'
  return 'LOW'
}
