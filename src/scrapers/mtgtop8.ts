import 'dotenv/config'
import { supabase } from '../lib/supabase.js'

const BASE_URL = 'https://www.mtgtop8.com'
const RATE_LIMIT_MS = 2000
const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/firemind)'

const FORMAT_PAGES: { url: string; format: string }[] = [
  { url: `${BASE_URL}/format?f=MO`, format: 'modern' },
  { url: `${BASE_URL}/format?f=ST`, format: 'standard' },
]

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

// Extract event URLs from a MTGTop8 format listing page.
// Links look like href="/event?e=12345"
export function extractEventUrls(html: string): string[] {
  const matches = [...html.matchAll(/href="(\/event\?e=(\d+))"/g)]
  return [...new Set(matches.map(m => BASE_URL + m[1]))]
}

async function getAlreadyScrapedUrls(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('source_url')
    .eq('source', 'mtgtop8')
    .not('source_url', 'is', null)
  if (error) throw new Error(`DB error: ${error.message}`)
  return new Set((data ?? []).map(r => r.source_url!))
}

async function scrapeEvent(url: string, format: string): Promise<'stored' | 'skipped' | 'error'> {
  let html: string
  try {
    html = await fetchText(url)
  } catch (err) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtgtop8',
      source_url: url,
      status: 'failed',
      error: String(err),
    })
    return 'error'
  }

  // Must have deck links to be worth parsing
  if (!html.includes('mtgo?d=')) {
    await supabase.from('scrape_jobs').insert({
      source: 'mtgtop8',
      source_url: url,
      status: 'skipped',
      error: 'No deck export links found',
    })
    return 'skipped'
  }

  // Embed the detected format in a comment at the top of raw_content so the parser can read it
  const annotated = `<!--mtgtop8-format:${format}-->\n${html}`
  const { error } = await supabase.from('scrape_jobs').insert({
    source: 'mtgtop8',
    source_url: url,
    raw_content: annotated,
    status: 'pending',
  })
  if (error) throw new Error(`Insert error: ${error.message}`)
  return 'stored'
}

export async function scrapeNewMtgtop8Events(): Promise<void> {
  const alreadyScraped = await getAlreadyScrapedUrls()

  for (const { url: listingUrl, format } of FORMAT_PAGES) {
    console.log(`[mtgtop8] Fetching ${format} listing...`)
    const listingHtml = await fetchText(listingUrl)
    const allUrls = extractEventUrls(listingHtml)
    console.log(`[mtgtop8] Found ${allUrls.length} ${format} event URLs`)

    const newUrls = allUrls.filter(u => !alreadyScraped.has(u))
    console.log(`[mtgtop8] ${newUrls.length} new`)

    let stored = 0, skipped = 0, errors = 0
    for (const [i, url] of newUrls.entries()) {
      const result = await scrapeEvent(url, format)
      if (result === 'stored') stored++
      else if (result === 'skipped') skipped++
      else errors++
      console.log(`[mtgtop8] ${result}: ${url}`)
      if (i < newUrls.length - 1) await sleep(RATE_LIMIT_MS)
    }
    console.log(`[mtgtop8] ${format} done — stored: ${stored}, skipped: ${skipped}, errors: ${errors}`)
  }
}
