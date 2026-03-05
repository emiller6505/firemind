import 'dotenv/config'
import { supabase } from '../lib/supabase.js'
import { parseAndStoreArticle } from '../parsers/mtggoldfish-articles.js'

const BASE_URL = 'https://www.mtggoldfish.com'
const RATE_LIMIT_MS = 2000
const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/firemind)'
const MAX_PAGES = 10

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

export function extractArticleUrls(html: string): string[] {
  const re = /href="(\/articles\/[^"]+)"/g
  const urls = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const path = m[1]
    // Skip search/tag/page links — only want actual article pages
    if (path.includes('/search') || path.includes('?tag=') || path.includes('?page=')) continue
    urls.add(BASE_URL + path)
  }
  return [...urls]
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

export function extractArticleMeta(html: string): { title: string; author: string | null; publishedAt: string | null; format: string | null } {
  // Title: first <h1> or <h2> with class containing "title"
  const titleMatch = html.match(/<h[12][^>]*>([^<]+)</) ?? html.match(/<title>([^<|]+)/)
  const title = titleMatch?.[1]?.trim() ?? 'Untitled'

  // Author: link text from author search link
  const authorMatch = html.match(/\/articles\/search\?author=[^"]*"[^>]*>([^<]+)</)
  const author = authorMatch?.[1]?.trim() ?? null

  // Date: "Mon DD, YYYY" pattern near author area
  const dateMatch = html.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/)
  let publishedAt: string | null = null
  if (dateMatch) {
    const month = MONTHS[dateMatch[1]]
    if (month) {
      const day = dateMatch[2].padStart(2, '0')
      publishedAt = `${dateMatch[3]}-${month}-${day}`
    }
  }

  // Format: check title and surrounding text for format keywords
  const lower = (title + ' ' + html.slice(0, 5000)).toLowerCase()
  let format: string | null = null
  if (lower.includes('modern')) format = 'modern'
  else if (lower.includes('standard')) format = 'standard'
  else if (lower.includes('pioneer')) format = 'pioneer'
  else if (lower.includes('legacy')) format = 'legacy'

  return { title, author, publishedAt, format }
}

async function getAlreadyScrapedUrls(): Promise<Set<string>> {
  // Inner join: only articles that have at least one chunk are considered done.
  // Orphaned articles (row exists, no chunks) will be retried.
  const { data, error } = await supabase
    .from('articles')
    .select('url, article_chunks!inner(id)')
  if (error) throw new Error(`DB error: ${error.message}`)
  return new Set((data ?? []).map(r => r.url))
}

export async function scrapeNewMtggoldfishArticles(): Promise<void> {
  const alreadyScraped = await getAlreadyScrapedUrls()
  let totalNew = 0, totalErrors = 0

  for (let page = 1; page <= MAX_PAGES; page++) {
    const listingUrl = `${BASE_URL}/articles?page=${page}`
    console.log(`[articles] Fetching listing page ${page}...`)
    const listingHtml = await fetchText(listingUrl)
    const allUrls = extractArticleUrls(listingHtml)
    console.log(`[articles] Found ${allUrls.length} article URLs on page ${page}`)

    const newUrls = allUrls.filter(u => !alreadyScraped.has(u))
    if (newUrls.length === 0) {
      console.log(`[articles] All URLs on page ${page} already scraped — stopping`)
      break
    }

    for (const [i, url] of newUrls.entries()) {
      try {
        console.log(`[articles] Fetching ${url}`)
        const html = await fetchText(url)
        const meta = extractArticleMeta(html)

        if (!meta.publishedAt) {
          console.warn(`[articles] Skipping ${url} — no date found`)
          continue
        }

        const { data: article, error: insertErr } = await supabase
          .from('articles')
          .insert({
            source: 'mtggoldfish',
            url,
            title: meta.title,
            author: meta.author,
            published_at: meta.publishedAt,
            format: meta.format,
          })
          .select('id')
          .single()

        if (insertErr) {
          if (insertErr.code === '23505') {
            // Article row exists but has no chunks (otherwise getAlreadyScrapedUrls
            // would have filtered it). Fetch existing ID and reprocess.
            const { data: existing } = await supabase
              .from('articles')
              .select('id')
              .eq('url', url)
              .single()
            if (existing) {
              console.log(`[articles] Reprocessing incomplete article: ${url}`)
              await parseAndStoreArticle(existing.id, html)
              totalNew++
            }
            alreadyScraped.add(url)
            continue
          }
          console.error(`[articles] Insert error for ${url}: ${insertErr.message}`)
          totalErrors++
          continue
        }

        await parseAndStoreArticle(article.id, html)
        totalNew++
        alreadyScraped.add(url)
      } catch (err) {
        console.error(`[articles] Error processing ${url}:`, err)
        totalErrors++
      }

      if (i < newUrls.length - 1) await sleep(RATE_LIMIT_MS)
    }

    await sleep(RATE_LIMIT_MS)
  }

  console.log(`[articles] Done — new: ${totalNew}, errors: ${totalErrors}`)
}
