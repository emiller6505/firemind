import 'dotenv/config'
import { createHash } from 'node:crypto'
import { supabase } from '../lib/supabase.js'

const BASE_URL = 'https://www.mtgtop8.com'
const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/firemind)'
const RATE_LIMIT_MS = 1500
const MAX_DECK_FETCH = 32

function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    return res.text()
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// HTML extraction helpers
// ---------------------------------------------------------------------------

// Read the format annotation injected by the scraper
function readFormat(html: string): 'modern' | 'standard' | null {
  const m = html.match(/<!--mtgtop8-format:(modern|standard)-->/)
  return m ? (m[1] as 'modern' | 'standard') : null
}

// Extract event ID from source URL e.g. /event?e=12345
function extractEventId(sourceUrl: string): string | null {
  const m = sourceUrl.match(/[?&]e=(\d+)/)
  return m ? m[1] : null
}

interface TournamentMeta {
  name: string
  date: string    // YYYY-MM-DD
  format: 'modern' | 'standard'
  eventId: string
}

interface StandingRow {
  placement: number
  deckId: string   // MTGTop8 deck ID
  eventId: string
  pilot: string
  deckName: string
}

// MTGTop8 event pages have the tournament name in the page title or a header.
// Date appears in format "DD/MM/YYYY" or "Month DD, YYYY".
export function extractTournamentMeta(html: string, sourceUrl: string): TournamentMeta | null {
  const format = readFormat(html)
  if (!format) return null

  const eventId = extractEventId(sourceUrl)
  if (!eventId) return null

  // Extract name from <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const rawTitle = titleMatch ? titleMatch[1] : `Event ${eventId}`
  const name = rawTitle.replace(/\s*[\|–\-]\s*mtgtop8.*$/i, '').trim() || `MTGTop8 Event ${eventId}`

  // MTGTop8 shows dates as "DD/MM/YYYY" in their event headers
  const euDateMatch = html.match(/(\d{2})\/(\d{2})\/(20\d{2})/)
  let date: string | null = null
  if (euDateMatch) {
    // DD/MM/YYYY → YYYY-MM-DD
    date = `${euDateMatch[3]}-${euDateMatch[2]}-${euDateMatch[1]}`
  } else {
    const isoMatch = html.match(/20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/)
    date = isoMatch ? isoMatch[0] : null
  }
  if (!date) return null  // can't store without a date (column is NOT NULL)

  return { name, date, format, eventId }
}

// MTGTop8 deck links use the pattern: /event?e={eventId}&d={deckId}
// or the MTGO export: /mtgo?d={deckId}&e={eventId}
// Standings are in a table where each row has a rank, player, and archetype.
export function extractStandings(html: string): StandingRow[] {
  const eventIdMatch = html.match(/<!--mtgtop8-format:[^>]+-->\n[\s\S]*?[?&]e=(\d+)/)
  // Re-extract event ID from the URL embedded in links in the HTML
  const standings: StandingRow[] = []

  // Match lines with deck export links — pattern: /mtgo?d={deckId}&e={eventId}
  const re = /href="\/mtgo\?d=(\d+)&amp;e=(\d+)"/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()

  while ((m = re.exec(html)) !== null) {
    const deckId = m[1]
    const eventId = m[2]
    if (seen.has(deckId)) continue
    seen.add(deckId)

    // Get a window around this match to find placement and pilot
    const before = html.slice(Math.max(0, m.index - 600), m.index)
    const after = html.slice(m.index, m.index + 400)

    // Placement: look for a small integer inside a <td> in the rows before the deck link.
    // Use the last <td>…</td> that contains only a number to avoid matching years/set numbers.
    const placementMatch = before.match(/<td[^>]*>\s*([1-9]\d?)\s*<\/td>(?![\s\S]*<td[^>]*>\s*[1-9]\d?\s*<\/td>)/)
      ?? before.match(/<td[^>]*>\s*([1-9]\d?)\s*<\/td>/)
    const placement = placementMatch ? parseInt(placementMatch[1], 10) : standings.length + 1

    if (placement > MAX_DECK_FETCH) continue

    // Pilot: look for a player name near this deck link
    const pilotMatch = before.match(/<td[^>]*>\s*([A-Za-z0-9_\- ]{2,32})\s*<\/td>\s*$/)
    const pilot = pilotMatch ? pilotMatch[1].trim() : 'Unknown'

    // Deck name: look for archetype label near the link
    const nameMatch = after.match(/class="[^"]*archetype[^"]*"[^>]*>([^<]+)</)
      ?? before.match(/class="[^"]*archetype[^"]*"[^>]*>([^<]+)</)
    const deckName = nameMatch ? nameMatch[1].trim() : 'Unknown Archetype'

    standings.push({ placement, deckId, eventId, pilot, deckName })
  }

  return standings.sort((a, b) => a.placement - b.placement)
}

// Parse MTGTop8's MTGO export format.
// The format is typically lines of "4 CardName" separated by a blank line for sideboard.
export function parseDeckExport(text: string): { mainboard: { name: string; qty: number }[]; sideboard: { name: string; qty: number }[] } {
  const mainboard: { name: string; qty: number }[] = []
  const sideboard: { name: string; qty: number }[] = []

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let inSideboard = false

  for (const line of lines) {
    if (/^sideboard:?$/i.test(line)) { inSideboard = true; continue }
    const match = line.match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const entry = { name: match[2].trim(), qty: parseInt(match[1], 10) }
    if (inSideboard) sideboard.push(entry)
    else mainboard.push(entry)
  }

  // If no explicit sideboard marker, try to detect by blank lines in original text
  if (sideboard.length === 0) {
    const sections = text.trim().split(/\n\s*\n/)
    if (sections.length >= 2) {
      mainboard.length = 0
      sideboard.length = 0
      for (const line of sections[0].split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/)
        if (m) mainboard.push({ name: m[2].trim(), qty: parseInt(m[1], 10) })
      }
      for (const section of sections.slice(1)) {
        for (const line of section.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(.+)$/)
          if (m) sideboard.push({ name: m[2].trim(), qty: parseInt(m[1], 10) })
        }
      }
    }
  }

  return { mainboard, sideboard }
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

async function parseJob(job: { id: number; source_url: string; raw_content: string }): Promise<void> {
  const meta = extractTournamentMeta(job.raw_content, job.source_url)
  if (!meta) throw new Error('Could not extract tournament metadata')

  const standings = extractStandings(job.raw_content)
  if (standings.length === 0) throw new Error('No standings found')

  const tournamentId = stableId('mtgtop8', meta.eventId)

  const { error: tErr } = await supabase
    .from('tournaments')
    .upsert({
      id:         tournamentId,
      name:       meta.name,
      format:     meta.format,
      date:       meta.date,
      source:     'mtgtop8',
      source_url: job.source_url,
      tier:       inferTier(meta.name),
    }, { onConflict: 'id' })
  if (tErr) throw new Error(`Tournament upsert: ${tErr.message}`)

  console.log(`[mtgtop8-parser] ${meta.name} (${meta.date}) — ${standings.length} standings`)

  for (const [i, standing] of standings.entries()) {
    const exportUrl = `${BASE_URL}/mtgo?d=${standing.deckId}&e=${standing.eventId}`
    let deckText: string
    try {
      deckText = await fetchText(exportUrl)
    } catch (err) {
      console.warn(`[mtgtop8-parser] Failed to fetch deck ${standing.deckId}: ${err}`)
      continue
    }

    const rawList = parseDeckExport(deckText)
    if (rawList.mainboard.length === 0) {
      console.warn(`[mtgtop8-parser] Empty deck list for ${standing.deckId}`)
      continue
    }

    const deckId = stableId('mtgtop8', meta.eventId, standing.deckId)
    const { error: dErr } = await supabase
      .from('decks')
      .upsert({
        id:            deckId,
        tournament_id: tournamentId,
        pilot:         standing.pilot,
        placement:     standing.placement,
        source:        'mtgtop8',
        source_url:    `${BASE_URL}/event?e=${standing.eventId}&d=${standing.deckId}`,
        raw_list:      rawList,
      }, { onConflict: 'id' })
    if (dErr) throw new Error(`Deck upsert: ${dErr.message}`)

    const allCards = [...rawList.mainboard, ...rawList.sideboard]
    const cardIdMap = await resolveCardIds(allCards.map(c => c.name))

    const deckCardRows = [
      ...rawList.mainboard.map(c => ({ card_name: c.name, card_id: cardIdMap.get(c.name) ?? null, quantity: c.qty, is_sideboard: false })),
      ...rawList.sideboard.map(c => ({ card_name: c.name, card_id: cardIdMap.get(c.name) ?? null, quantity: c.qty, is_sideboard: true })),
    ]

    const { error: dcErr } = await supabase.rpc('sync_deck_cards', {
      p_deck_id: deckId,
      p_rows:    deckCardRows,
    })
    if (dcErr) throw new Error(`Deck cards sync: ${dcErr.message}`)

    if (i < standings.length - 1) await sleep(RATE_LIMIT_MS)
  }
}

export async function parsePendingMtgtop8Jobs(): Promise<void> {
  const { data: jobs, error } = await supabase
    .from('scrape_jobs')
    .update({ status: 'in_progress' })
    .eq('source', 'mtgtop8')
    .eq('status', 'pending')
    .select('id, source_url, raw_content')
    .order('id')
  if (error) throw new Error(`Fetch pending jobs: ${error.message}`)
  if (!jobs?.length) { console.log('[mtgtop8-parser] No pending jobs'); return }

  console.log(`[mtgtop8-parser] Processing ${jobs.length} pending jobs...`)

  for (const job of jobs) {
    try {
      await parseJob(job as { id: number; source_url: string; raw_content: string })
      await supabase
        .from('scrape_jobs')
        .update({ status: 'parsed', parsed_at: new Date().toISOString() })
        .eq('id', job.id)
      console.log(`[mtgtop8-parser] parsed: ${job.source_url}`)
    } catch (err) {
      await supabase
        .from('scrape_jobs')
        .update({ status: 'failed', error: String(err) })
        .eq('id', job.id)
      console.error(`[mtgtop8-parser] failed: ${job.source_url} —`, err)
    }
  }
}
