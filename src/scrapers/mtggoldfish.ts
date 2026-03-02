import 'dotenv/config'
import { supabase } from '../lib/supabase.js'

const BASE_URL = 'https://www.mtggoldfish.com'
const LISTING_URL = `${BASE_URL}/tournament/results`
const RATE_LIMIT_MS = 2000
const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/firemind)'

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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Extract tournament URLs from the results listing page.
// MTGGoldfish links look like href="/tournament/12345" with tournament names
// containing "Modern" or "Standard" in surrounding text.
export function extractTournamentUrls(html: string): string[] {
  // Match tournament links and capture adjacent text window to check format
  const results: string[] = []
  const re = /href="(\/tournament\/(\d+)[^"]*)"/g
  let m: RegExpExecArray | null

  while ((m = re.exec(html)) !== null) {
    const path = m[1]
    // Check a window of characters around this match for format keywords
    const window = html.slice(Math.max(0, m.index - 200), m.index + 200).toLowerCase()
    if (window.includes('modern') || window.includes('standard')) {
      results.push(BASE_URL + path)
    }
  }

  // Deduplicate (the same tournament can appear multiple times in the listing)
  return [...new Set(results)]
}

async function getAlreadyScrapedUrls(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('source_url')
    .eq('source', 'mtggoldfish')
    .not('source_url', 'is', null)
  if (error) throw new Error(`DB error: ${error.message}`)
  return new Set((data ?? []).map(r => r.source_url!))
}

async function scrapeTournament(url: string): Promise<'stored' | 'skipped' | 'error'> {
  let html: string
  try {
    html = await fetchText(url)
  } catch (err) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtggoldfish',
      source_url: url,
      status: 'failed',
      error: String(err),
    })
    return 'error'
  }

  // Quick sanity check — the page should have a results table
  if (!html.includes('/deck/')) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtggoldfish',
      source_url: url,
      status: 'skipped',
      error: 'No deck links found in tournament page',
    })
    return 'skipped'
  }

  const { error } = await supabase.from('scrape_jobs').insert({
    source: 'mtggoldfish',
    source_url: url,
    raw_content: html,
    status: 'pending',
  })
  if (error) throw new Error(`Insert error: ${error.message}`)
  return 'stored'
}

export async function scrapeNewMtggoldfishEvents(): Promise<void> {
  console.log('[mtggoldfish] Fetching tournament listing...')
  const listingHtml = await fetchText(LISTING_URL)
  const allUrls = extractTournamentUrls(listingHtml)
  console.log(`[mtggoldfish] Found ${allUrls.length} Modern/Standard tournament URLs`)

  const alreadyScraped = await getAlreadyScrapedUrls()
  const newUrls = allUrls.filter(u => !alreadyScraped.has(u))
  console.log(`[mtggoldfish] ${newUrls.length} new (${alreadyScraped.size} already stored)`)

  let stored = 0, skipped = 0, errors = 0

  for (const [i, url] of newUrls.entries()) {
    const result = await scrapeTournament(url)
    if (result === 'stored') stored++
    else if (result === 'skipped') skipped++
    else errors++
    console.log(`[mtggoldfish] ${result}: ${url}`)
    if (i < newUrls.length - 1) await sleep(RATE_LIMIT_MS)
  }

  console.log(`[mtggoldfish] Done — stored: ${stored}, skipped: ${skipped}, errors: ${errors}`)
}
