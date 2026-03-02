# Firemind — Architecture

## What It Is
A Magic: the Gathering metagame oracle. Aggregates tournament results, derives opinions backed by data, and answers questions ranging from "what should I play as a beginner" to "build me the most competitive Modern deck from the last 3 months."

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js (App Router) |
| Language | TypeScript (full stack) |
| LLM Orchestration | LangChain.js |
| Database | Supabase (Postgres + pgvector) |
| Scraping | Playwright |
| Scheduling | Render cron jobs (12hr cadence) |
| LLM Provider | Claude API (abstracted — swappable) |
| Card Data | Scryfall bulk API |
| Hosting | Render (compute) + Supabase (DB) |

---

## Deployment

```
Render
├── Web service       (Next.js — frontend + query API)
├── Background worker (scraper + indexing agents)
└── Cron jobs         (scrape triggers, every 12h)

Supabase
└── Postgres + pgvector
```

---

## Data Sources

| Source | What | Cadence |
|---|---|---|
| MTGO decklists | Tournament results, structured | 12h |
| MTGGoldfish | Metagame %, archetype trends | 12h |
| MTGTop8 | Historical tournament results | 12h |
| Scryfall bulk API | Full card database | Weekly |

Formats in scope: **Modern, Standard** (RCQ formats). Legacy + cEDH later.

---

## Data Model

```
cards               ← Scryfall sync
tournaments         ← scraped (name, format, date, source, tier)
decks               ← scraped (linked to tournament + pilot)
deck_cards          ← normalized (deck_id, card_id, quantity, is_sideboard)
archetypes          ← derived dynamically via clustering + LLM
deck_archetypes     ← mapping with confidence score
metagame_snapshots  ← materialized (archetype share %, trend delta, confidence)
scrape_jobs         ← raw staging table (source, raw content, fetched_at)
embeddings          ← pgvector (decks, archetypes, card oracle text)
```

---

## Scraper Pipeline

Four stages, each with a distinct job:

```
Fetcher → Parser → Embedder → Analyzer
```

- **Fetcher** — dumps raw HTML/JSON into `scrape_jobs` staging table. Dumb, idempotent.
- **Parser** — source-specific modules that normalize raw content into structured entities.
- **Embedder** — generates and upserts embeddings for new/changed entities.
- **Analyzer** — runs on slower schedule (daily), computes metagame snapshots and trend deltas.

Re-parsing without re-scraping is possible because raw content is preserved in `scrape_jobs`.

---

## Query Pipeline

```
User query
  → Intent extraction (small LLM call → structured JSON)
  → Retrieval planning (SQL + vector in parallel)
  → Context assembly (grounded fact block)
  → LLM call (Claude synthesizes from retrieved facts)
  → Response formatting (prose + optional deck list)
```

Intent extraction output shape:
```ts
{
  format: 'modern' | 'standard',
  archetype: string | null,
  window_days: number,
  task: 'deck_build' | 'meta_query' | 'advice' | 'comparison',
  budget: number | null
}
```

---

## Archetype Classification

**Hybrid approach:**
1. Card signature matching (fast path — key cards → known archetype)
2. Jaccard similarity clustering (group unknown decks by card overlap)
3. LLM classification fallback (label clusters, handle edge cases)

Archetypes are derived dynamically — no manually maintained list.
Admin override tool planned for future (manual decree to nudge the system).

---

## Confidence Scoring

```
score = (
  log(sample_size + 1) * 0.4 +
  recency_weight       * 0.4 +   // exponential decay, ~30d half-life
  source_diversity     * 0.2     // penalize single-source data
)
→ normalized to: LOW | MEDIUM | HIGH | VERY HIGH
```

Stored on `metagame_snapshots`. Surfaced in UI and passed to LLM for hedging language.

---

## LLM Provider Abstraction

```ts
interface LLMProvider {
  complete(prompt: string, context: string[], opts?: CompletionOpts): Promise<string>
}
```

Ships with `ClaudeProvider`. Swap to self-hosted open-source model (Llama, Mistral via Ollama/vLLM) when cost pressure warrants it. Fine-tuning considered only for narrow tasks (archetype classification, deck list formatting).

---

## Output Formats

- **MTGA** — plain text, `4 Lightning Bolt` per line
- **MTGO** — similar syntax, format-tagged

---

## Frontend

Hybrid chat UI:
- Persistent context filters (format, date window) — set once, inherited by all queries in session
- Free-form natural language input
- Inline filter overrides handled by the model ("what about in Pioneer?")
