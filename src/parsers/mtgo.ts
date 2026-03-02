import 'dotenv/config'
import { createHash } from 'node:crypto'
import { supabase } from '../lib/supabase.js'
import { extractEventData, FORMAT_MAP } from '../scrapers/mtgo.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

// Look up canonical card_id from cards table by name.
// Returns the most recently updated printing for the given name.
async function resolveCardIds(names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names)]
  const { data, error } = await supabase
    .from('cards')
    .select('id, name')
    .in('name', unique)
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`Card lookup error: ${error.message}`)

  // Keep first match per name (most recent printing)
  const map = new Map<string, string>()
  for (const row of data ?? []) {
    if (!map.has(row.name)) map.set(row.name, row.id)
  }
  return map
}

// ---------------------------------------------------------------------------
// Parse a single scrape_job row
// ---------------------------------------------------------------------------

async function parseJob(job: { id: number; source_url: string; raw_content: string }) {
  const data = extractEventData(job.raw_content)
  if (!data) throw new Error('Could not extract event data from HTML')

  const format = FORMAT_MAP[data.format]
  if (!format) throw new Error(`Unsupported format: ${data.format}`)

  // Parse date from "YYYY-MM-DD HH:mm:ss.S"
  const eventDate = data.starttime.split(' ')[0]

  // ── Tournament ────────────────────────────────────────────────────────────
  const tournamentId = stableId('mtgo', data.event_id)
  const { error: tErr } = await supabase
    .from('tournaments')
    .upsert({
      id:         tournamentId,
      name:       data.description,
      format:     format,
      date:       eventDate,
      source:     'mtgo',
      source_url: job.source_url,
      tier:       inferTier(data.description),
    }, { onConflict: 'id' })
  if (tErr) throw new Error(`Tournament upsert: ${tErr.message}`)

  // Build standings lookup: player → rank
  const rankByPlayer = new Map(
    (data.standings ?? []).map(s => [s.login_name, parseInt(s.rank, 10)])
  )

  // Collect all card names we'll need to resolve
  const allCardNames = data.decklists.flatMap(d =>
    d.main_deck.map(c => c.card_attributes.card_name)
  )
  const cardIdMap = await resolveCardIds(allCardNames)

  // ── Decks + deck_cards ────────────────────────────────────────────────────
  for (const mtgoDeck of data.decklists) {
    const deckId = stableId('mtgo', data.event_id, mtgoDeck.decktournamentid)
    const placement = rankByPlayer.get(mtgoDeck.player) ?? null

    const mainboard = mtgoDeck.main_deck.filter(c => c.sideboard !== 'true')
    const sideboard = mtgoDeck.main_deck.filter(c => c.sideboard === 'true')

    const rawList = {
      mainboard: mainboard.map(c => ({ name: c.card_attributes.card_name, qty: Number(c.qty) })),
      sideboard: sideboard.map(c => ({ name: c.card_attributes.card_name, qty: Number(c.qty) })),
    }

    const { error: dErr } = await supabase
      .from('decks')
      .upsert({
        id:            deckId,
        tournament_id: tournamentId,
        pilot:         mtgoDeck.player,
        placement:     placement,
        source:        'mtgo',
        source_url:    job.source_url,
        raw_list:      rawList,
      }, { onConflict: 'id' })
    if (dErr) throw new Error(`Deck upsert: ${dErr.message}`)

    const deckCardRows = [...mainboard, ...sideboard].map(c => ({
      card_name:    c.card_attributes.card_name,
      card_id:      cardIdMap.get(c.card_attributes.card_name) ?? null,
      quantity:     Number(c.qty),
      is_sideboard: c.sideboard === 'true',
    }))

    const { error: dcErr } = await supabase.rpc('sync_deck_cards', {
      p_deck_id: deckId,
      p_rows:    deckCardRows,
    })
    if (dcErr) throw new Error(`Deck cards sync: ${dcErr.message}`)
  }
}

function inferTier(description: string): string | null {
  const d = description.toLowerCase()
  if (d.includes('showcase challenge')) return 'challenge'
  if (d.includes('challenge')) return 'challenge'
  if (d.includes('preliminary')) return 'preliminary'
  if (d.includes('league')) return 'preliminary'
  return null
}

// ---------------------------------------------------------------------------
// Main export — process all pending MTGO scrape_jobs
// ---------------------------------------------------------------------------

export async function parsePendingMtgoJobs(): Promise<void> {
  const { data: jobs, error } = await supabase
    .from('scrape_jobs')
    .update({ status: 'in_progress' })
    .eq('source', 'mtgo')
    .eq('status', 'pending')
    .select('id, source_url, raw_content')
    .order('id')
  if (error) throw new Error(`Fetch pending jobs: ${error.message}`)
  if (!jobs?.length) { console.log('[mtgo-parser] No pending jobs'); return }

  console.log(`[mtgo-parser] Processing ${jobs.length} pending jobs...`)

  for (const job of jobs) {
    try {
      await parseJob(job as { id: number; source_url: string; raw_content: string })
      await supabase
        .from('scrape_jobs')
        .update({ status: 'parsed', parsed_at: new Date().toISOString() })
        .eq('id', job.id)
      console.log(`[mtgo-parser] parsed: ${job.source_url?.split('/').pop()}`)
    } catch (err) {
      await supabase
        .from('scrape_jobs')
        .update({ status: 'failed', error: String(err) })
        .eq('id', job.id)
      console.error(`[mtgo-parser] failed: ${job.source_url?.split('/').pop()} —`, err)
    }
  }
}
