# Firemind

A Magic: The Gathering metagame oracle. Ask it anything — from "what should I play this weekend?" to "build me the best Modern deck from the last 3 months" — and get answers backed by real tournament data.

Try it out at [firemind.gg](https://firemind.gg)

## How It Works

Firemind scrapes tournament results from across the competitive Magic landscape — **MTGO**, **MTGGoldfish**, **MTGTop8** — and syncs the full card database from **Scryfall**. Every 12 hours, **Render** cron jobs kick off a scrape pipeline that fetches new events, parses decklists, and stores everything in a **Supabase** Postgres database powered by **pgvector** for vector search.

When you ask a question, the query pipeline breaks it down:

1. **Intent extraction** — a lightweight **Claude API** call figures out what you're really asking (format, archetype, time window, budget)
2. **Retrieval** — pulls the most relevant decks and card data using a combination of SQL queries and vector similarity search
3. **Synthesis** — **Claude** reads the retrieved data and generates a grounded, opinionated answer with real decklists and metagame context

Archetypes aren't hardcoded — they're discovered automatically through card-overlap clustering and LLM classification, so the system adapts as the meta shifts.

## Stack

- **Next.js** (App Router) — frontend and API
- **TypeScript** — full stack, end to end
- **Supabase** — Postgres + pgvector for structured and vector storage
- **Claude API** — intent extraction and response synthesis
- **Voyage AI** — embeddings
- **Playwright** — web scraping
- **Render** — compute, cron scheduling, deployment
- **Scryfall** — card data
- **Vitest** — testing

## Formats

Currently tracking **Modern** and **Standard** (RCQ). Legacy and cEDH are on the potential future roadmap.
