import 'dotenv/config'
import { createHash } from 'node:crypto'
import { supabase } from '../lib/supabase.js'

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

function inferTier(name: string): string | null {
  const n = name.toLowerCase()
  if (n.includes('pro tour')) return 'pro_tour'
  if (n.includes('regional championship') || n.includes('regional champ')) return 'regional'
  if (n.includes('qualifier') || n.includes('rcq')) return 'rcq'
  if (n.includes('challenge')) return 'challenge'
  if (n.includes('preliminary') || n.includes('league')) return 'preliminary'
  return null
}

async function resolveCardIds(names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names)]
  const { data, error } = await supabase
    .from('cards')
    .select('id, name')
    .in('name', unique)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`Card lookup error: ${error.message}`)

  const map = new Map<string, string>()
  for (const row of data ?? []) {
    if (!map.has(row.name)) map.set(row.name, row.id)
  }
  return map
}

interface CardEntry {
  id: string
  count: number
}

interface DeckObj {
  Mainboard?: Record<string, CardEntry>
  Sideboard?: Record<string, CardEntry>
  metadata?: unknown
}

interface Standing {
  name: string
  id: string
  standing: number
  points?: number
  winRate?: number
  decklist?: string | null
  deckObj?: DeckObj | null
}

interface TopdeckMeta {
  TID: string
  tournamentName: string
  startDate: number
  format: string
  topCut?: number
  swissNum?: number
}

async function parseJob(job: { id: number; source_url: string; raw_content: string }): Promise<void> {
  const { meta, standings } = JSON.parse(job.raw_content) as { meta: TopdeckMeta; standings: Standing[] }

  if (!standings || standings.length < 4) {
    throw new Error(`Too few players: ${standings?.length ?? 0}`)
  }

  const tournamentId = stableId('topdeck', meta.TID)
  const date = new Date(meta.startDate * 1000).toISOString().split('T')[0]
  const format = meta.format.toLowerCase() as 'modern' | 'standard'

  const { error: tErr } = await supabase
    .from('tournaments')
    .upsert({
      id:           tournamentId,
      name:         meta.tournamentName,
      format,
      date,
      source:       'topdeck',
      source_url:   `https://topdeck.gg/bracket/${meta.TID}`,
      tier:         inferTier(meta.tournamentName),
      player_count: standings.length,
    }, { onConflict: 'id' })
  if (tErr) throw new Error(`Tournament upsert: ${tErr.message}`)

  console.log(`[topdeck-parser] ${meta.tournamentName} (${date}) — ${standings.length} players`)

  let decksParsed = 0
  for (const standing of standings) {
    if (!standing.deckObj) continue

    const deckObj = standing.deckObj
    const mainboard = Object.entries(deckObj.Mainboard ?? {})
      .map(([name, { count }]) => ({ name, qty: count }))
    const sideboard = Object.entries(deckObj.Sideboard ?? {})
      .map(([name, { count }]) => ({ name, qty: count }))

    if (mainboard.length === 0) continue

    const deckId = stableId('topdeck', meta.TID, standing.id)
    const { error: dErr } = await supabase
      .from('decks')
      .upsert({
        id:            deckId,
        tournament_id: tournamentId,
        pilot:         standing.name,
        placement:     standing.standing,
        source:        'topdeck',
        source_url:    `https://topdeck.gg/bracket/${meta.TID}`,
        raw_list:      { mainboard, sideboard },
      }, { onConflict: 'id' })
    if (dErr) throw new Error(`Deck upsert (${standing.id}): ${dErr.message}`)

    const allNames = [...mainboard, ...sideboard].map(c => c.name)
    const cardIdMap = await resolveCardIds(allNames)

    const rows = [
      ...mainboard.map(c => ({ card_name: c.name, card_id: cardIdMap.get(c.name) ?? null, quantity: c.qty, is_sideboard: false })),
      ...sideboard.map(c => ({ card_name: c.name, card_id: cardIdMap.get(c.name) ?? null, quantity: c.qty, is_sideboard: true })),
    ]

    const { error: dcErr } = await supabase.rpc('sync_deck_cards', {
      p_deck_id: deckId,
      p_rows:    rows,
    })
    if (dcErr) throw new Error(`Deck cards sync (${standing.id}): ${dcErr.message}`)

    decksParsed++
  }

  console.log(`[topdeck-parser] Parsed ${decksParsed} decks with decklists`)
}

export async function parsePendingTopdeckJobs(): Promise<void> {
  const { data: jobs, error } = await supabase
    .from('scrape_jobs')
    .update({ status: 'in_progress' })
    .eq('source', 'topdeck')
    .eq('status', 'pending')
    .select('id, source_url, raw_content')
    .order('id')
  if (error) throw new Error(`Fetch pending jobs: ${error.message}`)
  if (!jobs?.length) { console.log('[topdeck-parser] No pending jobs'); return }

  console.log(`[topdeck-parser] Processing ${jobs.length} pending jobs...`)

  for (const job of jobs) {
    try {
      await parseJob(job as { id: number; source_url: string; raw_content: string })
      await supabase
        .from('scrape_jobs')
        .update({ status: 'parsed', parsed_at: new Date().toISOString() })
        .eq('id', job.id)
      console.log(`[topdeck-parser] parsed: ${job.source_url}`)
    } catch (err) {
      await supabase
        .from('scrape_jobs')
        .update({ status: 'failed', error: String(err) })
        .eq('id', job.id)
      console.error(`[topdeck-parser] failed: ${job.source_url} —`, err)
    }
  }
}
