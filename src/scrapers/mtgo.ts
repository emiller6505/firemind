import 'dotenv/config'
import { supabase } from '../lib/supabase.js'

const LISTING_URL = 'https://www.mtgo.com/decklists'
const BASE_URL = 'https://www.mtgo.com'
const RATE_LIMIT_MS = 1500
const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/firemind)'

export const FORMAT_MAP: Record<string, string> = {
  CMODERN:   'modern',
  CSTANDARD: 'standard',
}

const RELEVANT_URL_PREFIXES = ['modern-', 'standard-']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MtgoCard {
  qty: string
  sideboard: string       // "true" | "false"
  card_attributes: { card_name: string }
}

export interface MtgoDeck {
  player: string
  decktournamentid: string
  main_deck: MtgoCard[]
}

export interface MtgoStanding {
  login_name: string
  rank: string
  score: string
}

export interface MtgoEventData {
  event_id: string
  description: string
  starttime: string
  format: string
  type: string
  player_count?: number
  decklists: MtgoDeck[]
  standings: MtgoStanding[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchHtml(url: string): Promise<string> {
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

export function extractEventData(html: string): MtgoEventData | null {
  const marker = 'window.MTGO.decklists.data = '
  const start = html.indexOf(marker)
  if (start === -1) return null

  let depth = 0, i = start + marker.length, jsonStart = -1
  for (; i < html.length; i++) {
    if (html[i] === '{') { if (depth === 0) jsonStart = i; depth++ }
    else if (html[i] === '}') { depth--; if (depth === 0) break }
  }
  if (jsonStart === -1) return null

  return JSON.parse(html.slice(jsonStart, i + 1)) as MtgoEventData
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Get new event URLs from the listing page
// ---------------------------------------------------------------------------

async function getEventUrls(listingUrl = LISTING_URL): Promise<string[]> {
  const html = await fetchHtml(listingUrl)
  const matches = [...html.matchAll(/href="(\/decklist\/([^"]+))"/g)]
  return matches
    .filter(m => RELEVANT_URL_PREFIXES.some(p => m[2].startsWith(p)))
    .map(m => BASE_URL + m[1])
}

async function getAlreadyScrapedUrls(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('source_url')
    .eq('source', 'mtgo')
    .not('source_url', 'is', null)
  if (error) throw new Error(`DB error: ${error.message}`)
  return new Set((data ?? []).map(r => r.source_url!))
}

// ---------------------------------------------------------------------------
// Fetch and store a single event
// ---------------------------------------------------------------------------

async function scrapeEvent(url: string): Promise<'stored' | 'skipped' | 'error'> {
  let html: string
  try {
    html = await fetchHtml(url)
  } catch (err) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtgo',
      source_url: url,
      status: 'failed',
      error: String(err),
    })
    return 'error'
  }

  // Validate the page actually has event data before storing
  const data = extractEventData(html)
  if (!data) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtgo',
      source_url: url,
      status: 'skipped',
      error: 'No window.MTGO.decklists.data found in page',
    })
    return 'skipped'
  }

  // Skip formats we don't care about (safety check — URL filter should catch most)
  const format = FORMAT_MAP[data.format]
  if (!format) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtgo',
      source_url: url,
      status: 'skipped',
      error: `Unsupported format: ${data.format}`,
    })
    return 'skipped'
  }

  const { error } = await supabase.from('scrape_jobs').insert({
    source: 'mtgo',
    source_url: url,
    raw_content: html,
    status: 'pending',
  })
  if (error) throw new Error(`Insert error: ${error.message}`)

  return 'stored'
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function scrapeNewMtgoEvents(listingUrl = LISTING_URL): Promise<void> {
  console.log('[mtgo] Fetching event listing...')
  const allUrls = await getEventUrls(listingUrl)
  console.log(`[mtgo] Found ${allUrls.length} Modern/Standard event URLs on listing page`)

  const alreadyScraped = await getAlreadyScrapedUrls()
  const newUrls = allUrls.filter(u => !alreadyScraped.has(u))
  console.log(`[mtgo] ${newUrls.length} new (${alreadyScraped.size} already stored)`)

  let stored = 0, skipped = 0, errors = 0

  for (const [i, url] of newUrls.entries()) {
    const result = await scrapeEvent(url)
    if (result === 'stored') stored++
    else if (result === 'skipped') skipped++
    else errors++
    console.log(`[mtgo] ${result}: ${url.split('/').pop()}`)
    if (i < newUrls.length - 1) await sleep(RATE_LIMIT_MS)
  }

  console.log(`[mtgo] Done — stored: ${stored}, skipped: ${skipped}, errors: ${errors}`)
}
