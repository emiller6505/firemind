import 'dotenv/config'
import { createHash } from 'node:crypto'
import { supabase } from '../lib/supabase.js'

const BASE_URL = 'https://www.mtggoldfish.com'
const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/mindsculptor)'
const RATE_LIMIT_MS = 1500
const MAX_DECK_FETCH = 32  // only fetch top 32 deck lists

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
// Note: These regex patterns target MTGGoldfish's server-rendered HTML structure.
// If the site changes layout, these may need updating.
// ---------------------------------------------------------------------------

interface TournamentMeta {
  name: string
  date: string         // YYYY-MM-DD
  format: 'modern' | 'standard'
  sourceId: string     // MTGGoldfish numeric tournament ID
}

interface StandingRow {
  placement: number
  deckId: string       // MTGGoldfish deck ID
  deckName: string
  pilot: string
}

// Extract tournament ID from the source URL e.g. /tournament/12345
function extractTournamentId(sourceUrl: string): string | null {
  const m = sourceUrl.match(/\/tournament\/(\d+)/)
  return m ? m[1] : null
}

// MTGGoldfish tournament page has a title/header section.
// Typical format: "Modern Challenge 32" in an h1 or title tag.
// Date is often in a metadata section or page title.
export function extractTournamentMeta(html: string, sourceUrl: string): TournamentMeta | null {
  const sourceId = extractTournamentId(sourceUrl)
  if (!sourceId) return null

  // Detect format from page content
  const lower = html.toLowerCase()
  const format = lower.includes('modern') ? 'modern' : lower.includes('standard') ? 'standard' : null
  if (!format) return null

  // Extract tournament name from <title> tag or h1
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    ?? html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  const rawTitle = titleMatch ? titleMatch[1].replace(/\s*[|\-].*$/, '').trim() : `Tournament ${sourceId}`
  // Strip site name suffix e.g. "Modern Challenge 32 | MTGGoldfish"
  const name = rawTitle.replace(/\s*\|\s*MTGGoldfish.*$/i, '').trim()

  // Extract date — look for ISO date pattern in the HTML
  // MTGGoldfish often shows dates as "2026-02-28" or "Feb 28, 2026"
  const isoMatch = html.match(/20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])/)
  let date: string
  if (isoMatch) {
    date = isoMatch[0]
  } else {
    // Fallback: try to parse a natural date near the tournament name
    const naturalMatch = html.match(/(\w{3,9})\s+(\d{1,2}),?\s+(20\d{2})/)
    if (naturalMatch) {
      const d = new Date(`${naturalMatch[1]} ${naturalMatch[2]}, ${naturalMatch[3]}`)
      date = isNaN(d.getTime()) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0]
    } else {
      date = new Date().toISOString().split('T')[0]
    }
  }

  return { name, date, format, sourceId }
}

// Extract deck standings from tournament page HTML.
// MTGGoldfish results tables have rows with placement, deck link, player name.
export function extractStandings(html: string): StandingRow[] {
  const standings: StandingRow[] = []

  // Match table rows containing a deck link (/deck/DIGITS)
  // Typical row: <td>1</td><td><a href="/deck/67890">Burn</a></td><td>JohnDoe</td>
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1]
    if (!row.includes('/deck/')) continue

    // Placement: first <td> with a number
    const placementMatch = row.match(/<td[^>]*>\s*(\d+)\s*<\/td>/)
    if (!placementMatch) continue
    const placement = parseInt(placementMatch[1], 10)
    if (isNaN(placement) || placement > MAX_DECK_FETCH) continue

    // Deck link + name
    const deckMatch = row.match(/href="\/deck\/(\d+)[^"]*"[^>]*>([^<]+)<\/a>/)
    if (!deckMatch) continue
    const deckId = deckMatch[1]
    const deckName = deckMatch[2].trim()

    // Player name: next <td> after the deck cell
    const playerMatch = row.match(/href="\/deck\/\d+[^"]*"[^>]*>[^<]+<\/a>\s*<\/td>\s*<td[^>]*>\s*([^<\s][^<]*?)\s*<\/td>/)
    const pilot = playerMatch ? playerMatch[1].trim() : 'Unknown'

    standings.push({ placement, deckId, deckName, pilot })
  }

  return standings.sort((a, b) => a.placement - b.placement)
}

// Parse a deck download text (MTGO format) into mainboard + sideboard.
// Format:
//   4 Lightning Bolt
//   4 Goblin Guide
//   ...
//   Sideboard
//   2 Leyline of Sanctity
export function parseDeckDownload(text: string): { mainboard: { name: string; qty: number }[]; sideboard: { name: string; qty: number }[] } {
  const mainboard: { name: string; qty: number }[] = []
  const sideboard: { name: string; qty: number }[] = []
  let inSideboard = false

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^sideboard$/i.test(line)) { inSideboard = true; continue }

    const match = line.match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const entry = { name: match[2].trim(), qty: parseInt(match[1], 10) }
    if (inSideboard) sideboard.push(entry)
    else mainboard.push(entry)
  }

  return { mainboard, sideboard }
}

function inferTier(name: string): string | null {
  const n = name.toLowerCase()
  if (n.includes('showcase challenge') || n.includes('showcase')) return 'challenge'
  if (n.includes('challenge')) return 'challenge'
  if (n.includes('preliminary') || n.includes('league')) return 'preliminary'
  if (n.includes('regional championship') || n.includes('regional champ')) return 'regional'
  if (n.includes('qualifier') || n.includes('rcq')) return 'rcq'
  if (n.includes('pro tour')) return 'pro_tour'
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

// ---------------------------------------------------------------------------
// Parse a single pending scrape_job for MTGGoldfish
// ---------------------------------------------------------------------------

async function parseJob(job: { id: number; source_url: string; raw_content: string }): Promise<void> {
  const meta = extractTournamentMeta(job.raw_content, job.source_url)
  if (!meta) throw new Error('Could not extract tournament metadata')

  const standings = extractStandings(job.raw_content)
  if (standings.length === 0) throw new Error('No standings found in tournament page')

  const tournamentId = stableId('mtggoldfish', meta.sourceId)

  const { error: tErr } = await supabase
    .from('tournaments')
    .upsert({
      id:         tournamentId,
      name:       meta.name,
      format:     meta.format,
      date:       meta.date,
      source:     'mtggoldfish',
      source_url: job.source_url,
      tier:       inferTier(meta.name),
    }, { onConflict: 'id' })
  if (tErr) throw new Error(`Tournament upsert: ${tErr.message}`)

  console.log(`[mtggoldfish-parser] ${meta.name} (${meta.date}) — ${standings.length} standings`)

  for (const [i, standing] of standings.entries()) {
    const deckUrl = `${BASE_URL}/deck/download/${standing.deckId}`
    let deckText: string
    try {
      deckText = await fetchText(deckUrl)
    } catch (err) {
      console.warn(`[mtggoldfish-parser] Failed to fetch deck ${standing.deckId}: ${err}`)
      continue
    }

    const rawList = parseDeckDownload(deckText)
    if (rawList.mainboard.length === 0) {
      console.warn(`[mtggoldfish-parser] Empty deck list for ${standing.deckId}`)
      continue
    }

    const deckId = stableId('mtggoldfish', meta.sourceId, standing.deckId)
    const { error: dErr } = await supabase
      .from('decks')
      .upsert({
        id:            deckId,
        tournament_id: tournamentId,
        pilot:         standing.pilot,
        placement:     standing.placement,
        source:        'mtggoldfish',
        source_url:    `${BASE_URL}/deck/${standing.deckId}`,
        raw_list:      rawList,
      }, { onConflict: 'id' })
    if (dErr) throw new Error(`Deck upsert: ${dErr.message}`)

    await supabase.from('deck_cards').delete().eq('deck_id', deckId)

    const allCards = [...rawList.mainboard, ...rawList.sideboard.map(c => ({ ...c, side: true }))]
    const cardIdMap = await resolveCardIds(allCards.map(c => c.name))

    const deckCardRows = [
      ...rawList.mainboard.map(c => ({ deck_id: deckId, card_name: c.name, card_id: cardIdMap.get(c.name) ?? null, quantity: c.qty, is_sideboard: false })),
      ...rawList.sideboard.map(c => ({ deck_id: deckId, card_name: c.name, card_id: cardIdMap.get(c.name) ?? null, quantity: c.qty, is_sideboard: true })),
    ]

    if (deckCardRows.length > 0) {
      const { error: dcErr } = await supabase.from('deck_cards').insert(deckCardRows)
      if (dcErr) throw new Error(`Deck cards insert: ${dcErr.message}`)
    }

    if (i < standings.length - 1) await sleep(RATE_LIMIT_MS)
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function parsePendingMtggoldfishJobs(): Promise<void> {
  const { data: jobs, error } = await supabase
    .from('scrape_jobs')
    .select('id, source_url, raw_content')
    .eq('source', 'mtggoldfish')
    .eq('status', 'pending')
    .order('id')
  if (error) throw new Error(`Fetch pending jobs: ${error.message}`)
  if (!jobs?.length) { console.log('[mtggoldfish-parser] No pending jobs'); return }

  console.log(`[mtggoldfish-parser] Processing ${jobs.length} pending jobs...`)

  for (const job of jobs) {
    try {
      await parseJob(job as { id: number; source_url: string; raw_content: string })
      await supabase
        .from('scrape_jobs')
        .update({ status: 'parsed', parsed_at: new Date().toISOString() })
        .eq('id', job.id)
      console.log(`[mtggoldfish-parser] parsed: ${job.source_url}`)
    } catch (err) {
      await supabase
        .from('scrape_jobs')
        .update({ status: 'failed', error: String(err) })
        .eq('id', job.id)
      console.error(`[mtggoldfish-parser] failed: ${job.source_url} —`, err)
    }
  }
}
