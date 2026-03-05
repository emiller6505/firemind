import 'dotenv/config'
import { supabase } from '../lib/supabase.js'
import { parseAndStoreArticle, resetCaches } from '../parsers/mtggoldfish-articles.js'

const USER_AGENT = 'Mozilla/5.0 (compatible; firemind-bot/1.0; +https://github.com/emiller6505/firemind)'
const RATE_LIMIT_MS = 2000

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

async function main() {
  const { data: articles, error } = await supabase
    .from('articles')
    .select('id, url, title')
    .order('published_at', { ascending: false })

  if (error) throw new Error(`DB error: ${error.message}`)
  if (!articles?.length) {
    console.log('[backfill] No articles in DB')
    return
  }

  console.log(`[backfill] Found ${articles.length} articles to reprocess`)

  let success = 0, errors = 0

  for (const article of articles) {
    try {
      // Delete existing chunks for this article
      const { error: delErr } = await supabase
        .from('article_chunks')
        .delete()
        .eq('article_id', article.id)

      if (delErr) {
        console.error(`[backfill] Failed to delete chunks for ${article.title}: ${delErr.message}`)
        errors++
        continue
      }

      // Re-fetch HTML
      console.log(`[backfill] Fetching: ${article.title}`)
      const html = await fetchText(article.url)

      // Re-parse and store with embeddings
      await parseAndStoreArticle(article.id, html)
      success++
    } catch (err) {
      console.error(`[backfill] Error processing ${article.title}:`, err)
      errors++
    }

    await sleep(RATE_LIMIT_MS)
  }

  resetCaches()
  console.log(`[backfill] Done — success: ${success}, errors: ${errors}`)
}

main().catch(err => {
  console.error('[backfill] Fatal error:', err)
  process.exit(1)
})
