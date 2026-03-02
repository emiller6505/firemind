# Product Roadmap

## MVP — must haves

Three pillars. Without all three, the product can't acquire users, retain them, or monetize.

---

### 1. The Oracle

The core product. Chat-first interface backed by a live metagame data pipeline and LLM synthesis.

**Includes:**
- Scraping pipeline: MTGO decklists, MTGGoldfish, MTGTop8 — 12hr cadence
- RAG pipeline + Claude LLM synthesis
- Full-width chat UI: suggested prompts, inline query counter
- Inline data cards in oracle responses (archetype bars, trend arrows, tappable links to metagame pages)
- Query limits enforced: 5/day Casual, 30/day Spike

---

### 2. Auth, Tiers, and Payments

Without this, you can't monetize and can't gate features. Needs to ship with the oracle.

**Includes:**
- Discord OAuth + Google OAuth (no email/password)
- Stripe subscription: Casual (free) and Spike ($4.99/mo)
- Webhook from Stripe → Supabase to gate features in real-time
- Ephemeral sessions for unauthenticated users
- Soft inline gating: Spike features appear blurred with contextual upgrade prompt

---

### 3. Metagame Charts Section

The free half of the product. SEO flywheel, acquisition surface, and conversion funnel
into the oracle. All charts are public, SSR, no auth required.

**Includes:**
- `/data/[format]` — format overview: archetype breakdown chart, filterable by time
  range (7d / 30d / 90d), sortable by meta share or win rate
- `/data/[format]/[archetype]` — archetype detail: trend charts, win rate over time,
  recent MTGO results, and oracle CTA cluster
- Oracle CTAs on every archetype page: free "Ask the Firemind" + Spike-only
  "Generate deck list" and "Sideboard plan vs the field"
- `/chat/results/[id]` — shareable single-response permalinks for Reddit/social
- Dynamic OG images via `@vercel/og` (archetype name, meta %, trend arrow)
- Sitemap covering all metagame pages
- All content in real HTML — indexable by Google

---

## Post-MVP — ranked priorities

Features ship one at a time as they're ready — no big v2 release. Each item below is
self-contained and can go out independently. Order reflects priority, not batching.

### Tier 1 — first out the door

**Alert emails + weekly digest**
The stickiness engine. Brings Spike subscribers back every week without them having
to think about it. MTGO event alerts ("Titan just won the Showcase Challenge") and
a Sunday morning meta digest per format. Reuses the oracle synthesis pipeline.
See `alerts.md` for full spec.

**Chat history**
Spike: unlimited, searchable, resumable. History drawer (🕐) in nav.
Casual users see the icon but hit an upgrade prompt.
Long-term retention mechanic — users accumulate a research trail they don't want to lose.

---

### Tier 2 — next quarter

**Public meta reports (`/reports/[format]-[date]`)**
The weekly digest email published as a public SSR page. Fully indexed by Google.
SEO compound value over time — each report is a permanent, rankable page.
Mostly reuses the digest generation work.

**Events feed drawer**
Full MTGO results feed: Showcase Challenges, Prelims, Leagues. Filterable by format
and event type. Event detail with top 8/16, winning list, oracle commentary.
Casual: top 4. Spike: full event.

**Mobile optimization**
The full-width chat is reasonably mobile-friendly but needs a real pass.
MTG players check things between rounds on their phones. Reddit traffic skews mobile.
A bad mobile experience loses a meaningful slice of the acquisition funnel.

---

### Tier 3 — later

**Legacy format (Spike only)**
Passionate competitive audience, but scraping Legacy events is harder (less standardized
sources). Gates on having reliable data before shipping.

**Discord bot**
Oracle accessible inside playgroup servers. Massive organic spread potential —
every server that adds the bot is an acquisition channel. Significant engineering lift.
Probably worth doing once there's evidence of strong Discord word-of-mouth.

**cEDH format**
Niche but extremely dedicated community with real money to spend. Scraping cEDH events
is non-trivial. Later.

**Annual billing**
~20% discount for annual Spike subscriptions. Low engineering lift, meaningful impact
on churn and LTV. Easy to add once Stripe integration is stable.

**API access**
For content creators, deck-building tools, third-party integrations. Probably Spike
add-on or a separate tier. Demand-driven — add when users start asking for it.

**Admin archetype override tool**
For correcting clustering errors when the algorithm mislabels an archetype.
Internal tooling — add when it becomes a recurring operational pain.
