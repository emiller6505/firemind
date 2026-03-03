import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function main() {
  // 1. deck_cards sideboard counts by source
  const { data: decks } = await supabase
    .from('decks')
    .select('id, source, raw_list')
    .limit(500)

  const stats: Record<string, { total: number; withSideboard: number; withRawSideboard: number }> = {}
  for (const deck of decks ?? []) {
    const s = deck.source ?? 'unknown'
    if (!stats[s]) stats[s] = { total: 0, withSideboard: 0, withRawSideboard: 0 }
    stats[s].total++
    const raw = deck.raw_list as { mainboard?: unknown[]; sideboard?: unknown[] } | null
    if (raw?.sideboard && Array.isArray(raw.sideboard) && raw.sideboard.length > 0) {
      stats[s].withRawSideboard++
    }
  }

  console.log('\n=== raw_list.sideboard coverage by source ===')
  for (const [src, s] of Object.entries(stats)) {
    console.log(`  ${src}: ${s.withRawSideboard}/${s.total} decks have raw sideboard data`)
  }

  // 2. deck_cards sideboard row count by source
  const { data: dcRows } = await supabase
    .from('deck_cards')
    .select('is_sideboard, decks!inner(source)')
    .eq('is_sideboard', true)
    .limit(1000)

  const sbBySource: Record<string, number> = {}
  for (const row of dcRows ?? []) {
    const src = (row.decks as unknown as { source: string } | null)?.source ?? 'unknown'
    sbBySource[src] = (sbBySource[src] ?? 0) + 1
  }

  console.log('\n=== deck_cards rows with is_sideboard=true by source ===')
  if (Object.keys(sbBySource).length === 0) {
    console.log('  NONE — 0 sideboard rows in deck_cards')
  } else {
    for (const [src, count] of Object.entries(sbBySource)) {
      console.log(`  ${src}: ${count} rows`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
