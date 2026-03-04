# Article Ingestion Pipeline

End-to-end documentation of how strategy articles are fetched, chunked, embedded, stored, and served to the oracle query pipeline.

---

## Overview

The article pipeline gives Firemind access to expert MTG strategy content — sideboard guides, matchup theory, card evaluations — alongside tournament data. Articles are scraped from MTGGoldfish, split into semantic chunks, embedded with Voyage AI, and stored in Supabase with pgvector indexes. At query time, relevant chunks are retrieved via cosine similarity and injected into the LLM context as an "Expert Analysis" section.

```
Scrape → Chunk → Embed → Store → Retrieve → Assemble → LLM
```

---

## 1. Scraping

**File:** `src/scrapers/mtggoldfish-articles.ts`
**Trigger:** `src/workers/sync-articles.ts` (Render cron, weekly Monday 4am UTC)

The scraper walks MTGGoldfish article listing pages (up to 10), extracts article URLs via regex (`/articles/[^"]+`), and skips any already in the `articles` table. For each new URL:

1. Fetch the full HTML (30s timeout, 2s rate limit between requests)
2. Extract metadata: title (first `<h1>`/`<h2>`), author (from search link), published date (`Mon DD, YYYY` pattern), format (keyword detection in title + first 5000 chars: modern/standard/pioneer/legacy)
3. Skip articles with no parseable date
4. Insert row into `articles` table
5. Hand off `(articleId, html)` to the parser

**Key decisions:**
- Rate limit is 2s between requests — polite crawling, single-threaded
- URL dedup is done upfront via `SELECT url FROM articles` before fetching
- `User-Agent` identifies the bot with a contact URL
- When an entire listing page has zero new URLs, the scraper stops early (all older articles are already ingested)

---

## 2. Chunking

**File:** `src/parsers/mtggoldfish-articles.ts` → `chunkArticle()`

Chunking is a two-pass process:

### Pass 1: Header-based splitting
Split the HTML body on `<h2>` and `<h3>` boundaries. Each header starts a new section, preserving the header text as the section opener. This keeps sideboard guides, matchup sections, and card evaluations as cohesive units.

### Pass 2: Window splitting for long sections
Sections longer than 2000 chars get a sliding window applied:
- **Target size:** 2000 chars
- **Overlap:** 200 chars (context continuity across chunk boundaries)
- **Break points:** prefer paragraph boundaries (`\n\n`), fall back to sentence boundaries (`. `), fall back to hard cut
- **Min threshold:** chunks shorter than 100 chars are discarded

HTML is stripped before chunking: block elements convert to newlines, entities are decoded, triple+ newlines collapse to double.

**Why these numbers:** 2000 chars is roughly 500 tokens — large enough for a complete thought (a sideboard plan, a matchup analysis) but small enough to avoid drowning the LLM context. 200 char overlap prevents losing context at chunk boundaries. 100 char minimum filters noise (nav fragments, short disclaimers).

---

## 3. Enrichment

For each chunk, two enrichment steps run before storage:

### Card name extraction
**Function:** `extractCardNames(text, knownNames)`

Three strategies, layered:
1. **MTGGoldfish markdown links:** `[Lightning Bolt](/price/...)` — highest confidence
2. **HTML card links:** `<a href="/price/...">Lightning Bolt</a>` — catches pre-markdown content
3. **Known name matching:** brute-force substring match against the full Scryfall card database (~77k names, loaded once per sync run and cached). Names shorter than 3 chars are skipped to avoid false positives.

Results stored as `cards_mentioned text[]` on each chunk.

### Archetype tagging
**Function:** `extractArchetypes(text, archetypeNames)`

Case-insensitive substring match of known archetype names (loaded from `archetypes` table) against chunk text. If "Izzet Murktide" appears in the chunk, it gets tagged. Stored as `archetypes text[]`.

Both the card name set and archetype name list are cached in module-level variables for the duration of a sync run, then reset via `resetCaches()`.

---

## 4. Embedding

**Model:** Voyage AI `voyage-3` (1024 dimensions)
**File:** `src/lib/voyage.ts`

All chunks for an article are embedded in a single batch call to `voyage.embed()`. The resulting vectors are stored as JSON in the `embedding vector(1024)` column.

If embedding fails (API error, missing key), the chunk is still stored with `embedding: null` — it won't appear in similarity search but the content is preserved for re-embedding later.

---

## 5. Storage

### `articles` table
```sql
id            uuid PK
source        text NOT NULL          -- 'mtggoldfish'
url           text UNIQUE NOT NULL   -- dedup key
title         text NOT NULL
author        text                   -- nullable (some articles lack bylines)
published_at  timestamptz NOT NULL
format        text                   -- 'modern', 'standard', etc. or NULL (cross-format)
scraped_at    timestamptz DEFAULT now()
```

### `article_chunks` table
```sql
id              uuid PK
article_id      uuid FK → articles(id) ON DELETE CASCADE
chunk_index     int NOT NULL
content         text NOT NULL
embedding       vector(1024)          -- nullable (embedding can fail)
archetypes      text[] DEFAULT '{}'
cards_mentioned text[] DEFAULT '{}'
UNIQUE (article_id, chunk_index)
```

**Indexes:**
- IVFFlat on `embedding` with `vector_cosine_ops` (100 lists) — fast approximate nearest neighbor
- `articles(format, published_at DESC)` — format-scoped recency queries
- `articles(source, url)` — dedup lookups

Cascade delete ensures chunks are cleaned up when an article is removed.

---

## 6. Retrieval (Query Time)

**RPC:** `match_article_chunks(query_embedding, format_filter, match_count)`
**File:** `supabase/migrations/20260305100000_match_article_chunks_fn.sql`

The PostgreSQL function joins `article_chunks` → `articles`, filters by format (articles with `format IS NULL` are treated as cross-format and always included), orders by cosine similarity, and returns the top N rows (default 20) with full metadata.

```sql
WHERE ac.embedding IS NOT NULL
  AND (format_filter IS NULL OR a.format IS NULL OR a.format = format_filter)
ORDER BY ac.embedding <=> query_embedding
LIMIT match_count
```

---

## 7. Application-Side Post-Processing

**File:** `src/query/retrieval.ts` → `fetchRelevantArticles()`

The RPC returns 20 raw results. The app then applies three re-ranking steps:

### Archetype boost
If the user's intent includes an archetype or opponent archetype, chunks tagged with matching `archetypes[]` are sorted to the top. This ensures that a query about Burn gets Burn-specific sideboard guides before generic metagame analysis.

### Recency decay
Each chunk's similarity score is multiplied by a time-based decay factor:
- **Within the intent's timeframe** (e.g. 90 days): full weight (decay = 1.0)
- **Outside the window:** linear decay to 0 over 2x the timeframe

This prevents stale articles from dominating when fresher analysis exists, while still surfacing older content if nothing recent is available.

### Deduplication
Max 3 chunks per article. Prevents a single long article from consuming all context slots.

**Final output:** top 6 chunks, mapped to `ArticleChunk` objects (title, author, source, published_at, content, cards_mentioned).

---

## 8. Context Assembly

**File:** `src/query/assemble.ts`

When `article_chunks` is non-empty, an "Expert Analysis" section is rendered between Card Reference and Top Decks:

```
=== Expert Analysis ===
[MTGGoldfish - "Sideboard Guide: Modern Burn" by Frank Karsten, 2026-02-15]
Against control, you want to board in Eidolon of the Great Revel and cut Searing Blaze.
```

Each chunk gets a header line with source, title, author (if available), and publication date for attribution.

### System prompt guidance

The LLM is instructed to:
- Cite author and article title when referencing expert opinions
- Prefer recent articles over older ones when advice conflicts
- Let tournament results (actual placements) take precedence over article opinions when they disagree

This hierarchy — data > expert opinion — keeps Firemind grounded in empirical results while still surfacing strategic context.

---

## 9. Integration with Existing Pipeline

Article retrieval runs in the first `Promise.all` alongside `fetchTopDecks` and `fetchCardInfo`:

```
retrieveContext(intent)
  ├── fetchTopDecks(...)           ─┐
  ├── fetchCardInfo(...)            ├── Promise.all (parallel)
  └── fetchRelevantArticles(...)   ─┘
        │
        ▼
  articleChunks.cards_mentioned
        │
        ▼ merged into additionalNames
  fetchCardGlossary(decks, [...card_mentions, ...articleCardNames])
```

Cards mentioned in article chunks are merged into the card glossary lookup so the LLM gets oracle text for cards discussed in articles, even if those cards don't appear in any retrieved decklist.

---

## 10. Graceful Degradation

The pipeline degrades gracefully at every layer:

| Failure | Behavior |
|---|---|
| No `VOYAGE_API_KEY` | `fetchRelevantArticles` returns `[]`, no Expert Analysis section |
| Embedding API error during ingestion | Chunk stored with `embedding: null`, invisible to search |
| Embedding API error during query | `fetchRelevantArticles` catches, returns `[]` |
| RPC returns no matches | Empty array, no Expert Analysis section |
| No articles in DB | Same as no matches — pipeline proceeds with deck data only |

The oracle always works — article context is additive, never required.

---

## File Map

| File | Role |
|---|---|
| `src/scrapers/mtggoldfish-articles.ts` | Fetch article listings + HTML |
| `src/parsers/mtggoldfish-articles.ts` | Chunk, enrich, embed, store |
| `src/workers/sync-articles.ts` | Cron entrypoint |
| `src/lib/voyage.ts` | Voyage AI embedding client |
| `supabase/migrations/20260305000000_articles.sql` | Table schemas + indexes |
| `supabase/migrations/20260305100000_match_article_chunks_fn.sql` | Vector search RPC |
| `src/query/retrieval.ts` | `fetchRelevantArticles()` + wiring |
| `src/query/assemble.ts` | Expert Analysis section + system prompt |
| `src/parsers/__tests__/mtggoldfish-articles.test.ts` | Chunking + extraction tests |
| `src/query/__tests__/retrieval.test.ts` | Article retrieval tests |
| `src/query/__tests__/assemble.test.ts` | Expert Analysis rendering tests |
| `src/query/__tests__/pipeline.test.ts` | Full pipeline integration tests |
