const CHUNK_TARGET = 2000
const CHUNK_OVERLAP = 200
const MIN_CHUNK_LENGTH = 100

export function chunkArticle(body: string): string[] {
  // Split HTML on H2/H3 boundaries first, preserving the header text as section start
  const sections: string[] = []
  const headerRe = /<h[23][^>]*>/gi
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(body)) !== null) {
    if (m.index > lastIdx) {
      sections.push(body.slice(lastIdx, m.index))
    }
    lastIdx = m.index
  }
  if (lastIdx < body.length) sections.push(body.slice(lastIdx))

  // Clean each section: strip HTML, keep text
  const cleanSections = sections
    .map(stripHtml)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  // For sections that are too long, apply sliding window
  const chunks: string[] = []
  for (const section of cleanSections) {
    if (section.length <= CHUNK_TARGET) {
      if (section.length >= MIN_CHUNK_LENGTH) chunks.push(section)
    } else {
      chunks.push(...windowChunk(section))
    }
  }

  return chunks
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

function windowChunk(text: string): string[] {
  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + CHUNK_TARGET

    if (end >= text.length) {
      const remaining = text.slice(start).trim()
      if (remaining.length >= MIN_CHUNK_LENGTH) chunks.push(remaining)
      break
    }

    // Try to break at paragraph boundary
    const slice = text.slice(start, end)
    const paraBreak = slice.lastIndexOf('\n\n')
    if (paraBreak > CHUNK_TARGET * 0.3) {
      end = start + paraBreak + 2
    } else {
      // Fall back to sentence boundary
      const sentenceEnd = slice.lastIndexOf('. ')
      if (sentenceEnd > CHUNK_TARGET * 0.3) {
        end = start + sentenceEnd + 2
      }
    }

    const chunk = text.slice(start, end).trim()
    if (chunk.length >= MIN_CHUNK_LENGTH) chunks.push(chunk)

    start = end - CHUNK_OVERLAP
    if (start < 0) start = 0
  }

  return chunks
}

// Extract card names from MTGGoldfish link patterns + known names set
export function extractCardNames(text: string, knownNames: Set<string>): string[] {
  const found = new Set<string>()

  // MTGGoldfish card links: [Card Name](/price/...) or href="/price/..."
  const linkRe = /\[([^\]]+)\]\(\/price\/[^)]+\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(text)) !== null) {
    found.add(m[1].trim())
  }

  // HTML card links: <a...href="/price/...">Card Name</a>
  const htmlLinkRe = /<a[^>]*href="\/price\/[^"]*"[^>]*>([^<]+)<\/a>/g
  while ((m = htmlLinkRe.exec(text)) !== null) {
    found.add(m[1].trim())
  }

  // Match against known Scryfall names for unlinked mentions
  for (const name of knownNames) {
    if (name.length < 3) continue
    if (text.includes(name)) found.add(name)
  }

  return [...found]
}

// Cache card names across articles within a single sync run
let cardNameCache: Set<string> | null = null

async function loadKnownCardNames(): Promise<Set<string>> {
  if (cardNameCache) return cardNameCache

  const { supabase } = await import('../lib/supabase.js')
  // Paginate — cards table has ~77k rows, Supabase default limit is 1000
  const names = new Set<string>()
  const PAGE_SIZE = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('cards')
      .select('name')
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`Card names query error: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data) names.add(r.name)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  cardNameCache = names
  return cardNameCache
}

// Cache archetype names similarly
let archetypeNameCache: string[] | null = null

async function loadArchetypeNames(): Promise<string[]> {
  if (archetypeNameCache) return archetypeNameCache

  const { supabase } = await import('../lib/supabase.js')
  const { data, error } = await supabase
    .from('archetypes')
    .select('name')
  if (error) return []

  archetypeNameCache = (data ?? []).map(r => r.name)
  return archetypeNameCache
}

function extractArchetypes(text: string, archetypeNames: string[]): string[] {
  const lower = text.toLowerCase()
  return archetypeNames.filter(name => lower.includes(name.toLowerCase()))
}

export async function parseAndStoreArticle(articleId: string, html: string): Promise<void> {
  // Extract article body from MTGGoldfish's <div class='article-contents' id='article-body'>
  // Content ends at the tags/share container
  const bodyMatch = html.match(/<div[^>]*id=['"]article-body['"][^>]*>([\s\S]*?)<div[^>]*class=['"][^'"]*article-tags-share-container/i)
  const body = bodyMatch?.[1] ?? html

  const chunks = chunkArticle(body)
  if (chunks.length === 0) {
    console.log(`[articles] No chunks extracted for article ${articleId}`)
    return
  }

  const [knownNames, archetypeNames] = await Promise.all([
    loadKnownCardNames(),
    loadArchetypeNames(),
  ])

  // Embed all chunks for this article
  let vectors: number[][] = []
  try {
    const { embed } = await import('../lib/voyage.js')
    vectors = await embed(chunks)
  } catch (err) {
    console.warn(`[articles] Embedding failed for article ${articleId}:`, err)
  }

  const rows = chunks.map((content, i) => ({
    article_id: articleId,
    chunk_index: i,
    content,
    embedding: vectors[i] ? JSON.stringify(vectors[i]) : null,
    archetypes: extractArchetypes(content, archetypeNames),
    cards_mentioned: extractCardNames(content, knownNames),
  }))

  const { supabase } = await import('../lib/supabase.js')
  const { error } = await supabase
    .from('article_chunks')
    .insert(rows)

  if (error) throw new Error(`article_chunks insert: ${error.message}`)
  console.log(`[articles] Stored ${rows.length} chunks for article ${articleId}`)
}

// Reset caches — exposed for worker boundary
export function resetCaches() {
  cardNameCache = null
  archetypeNameCache = null
}
