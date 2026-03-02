# Information Architecture

## Acquisition context

Primary channels: Reddit, Meta ads (Facebook/Instagram), SEO. Podcasts post-MVP.

**Engineering implications:**
- Metagame section (`/data/**`) must be **public and SSR** — fully crawlable, no auth required
- Oracle section (`/chat`) requires auth to use but landing at `/` is public
- Dynamic OG images via `@vercel/og` on archetype and format pages
- Shareable oracle result permalinks for Reddit/social virality
- `/reports/[format]-[date]` — weekly digest as public indexed pages
- Sitemap covers all metagame pages
- Cold Meta ad traffic hero: *"Know what's winning before you register."*

---

## Two sections

### 1. Oracle (`/chat`)
Chat-first AI analysis. The core product and the primary paywall surface.
Format is conversational context here, not a persistent filter.

### 2. Metagame (`/data`)
Data visualization: charts, trends, archetype breakdowns. Fully free.
CTAs throughout funnel users into the oracle.

---

## Navigation

**Authenticated:**
```
[⚡ Firemind]    [Oracle]  [Metagame]    [🕐 History][🔔 Alerts][avatar ▾]
```

**Unauthenticated:**
```
[⚡ Firemind]    [Oracle]  [Metagame]    [Sign in]  [Go Spike ↑]
```

- Format toggle lives in the Metagame section only — not global
- 🕐, 🔔 open drawers (Spike only for 🕐 history; 1 alert free)
- No other top-level nav items

---

## Pages

### `/` — Landing

```
Know what's winning. Before you register.
[Ask about the metagame...                    →]

What's dominating Modern?    Best deck for RCQs?
Is Amulet Titan tier 1?      Standard after the ban?
──────────────────────────────────────────────────
MODERN                         STANDARD
Murktide  18.4% ↑   Amulet 13.1% →   Domain 21% ↑↑ ...
──────────────────────────────────────────────────
[ Sign up free — no credit card ]   [ See metagame charts → ]
```

- Oracle input is the hero — seeds curiosity immediately
- Live metagame data below fold — real numbers, no login required
- Two CTAs at the bottom: sign up for oracle, or explore charts freely
- All content is real HTML — indexable

---

### `/chat` — The Firemind

Full-width chat interface. The oracle is the product.

```
┌─────────────────────────────────────────────────────────┐
│  ⚡ Firemind    [Chat] [Data]       [🕐][🔔][  ]  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│              What would you like to know?               │
│                                                         │
│    ┌─────────────────────────────────────────────┐      │
│    │  What's dominating Modern right now?         │      │
│    │  What should I play at my RCQ this weekend?  │      │
│    │  Is Murktide still the deck to beat?         │      │
│    │  Build me a sideboard plan vs Amulet Titan   │      │
│    └─────────────────────────────────────────────┘      │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  5 / 5 queries today  ·  Ask the Firemind... [→] │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- Query counter inline with input: "5 / 5 queries today" (Casual) or "22 / 30" (Spike)
- Unauthenticated users can see the interface but must sign in to query
- Oracle responses embed inline data cards — archetype names are tappable links to `/data/[format]/[archetype]`
- Spike CTA appears when Casual hits query limit: "You're out of queries — upgrade for 30/day"

**Oracle response format:**
```
⚡ Firemind
┌──────────────────────────────────────────────────────┐
│ Modern is defined by three pillars this week:        │
│                                                      │
│  [Murktide Regent]  ██████████████  18.4%  ↑        │
│  [Amulet Titan]     ██████████      13.1%  →        │
│  [Boros Energy]     ███████          9.7%  ↑↑       │
│                                                      │
│ Energy is the breakout story — gained ~4% share      │
│ over two weeks, back-to-back Showcase top 8s...      │
└──────────────────────────────────────────────────────┘
```

Archetype names in responses link directly to metagame archetype pages.

**Chat history drawer (🕐 — Spike only):**
- Full conversation list, searchable
- Resume any past conversation
- Casual users see the icon but get an upgrade prompt

---

### `/data` — Format selector

Redirect or simple landing: choose Standard or Modern. On desktop, could default to Modern.

---

### `/data/[format]` — Format overview

Public, SSR, fully crawlable.

```
┌─────────────────────────────────────────────────────────┐
│  ⚡ Firemind    [Chat] [Data]       [🔔][  ]      │
├─────────────────────────────────────────────────────────┤
│  Modern Metagame          [7d ▾]  [Meta share ▾]        │
│                                                         │
│  ████████████████  Murktide Regent   18.4%  ↑          │
│  ████████████      Amulet Titan      13.1%  →          │
│  ████████          Boros Energy       9.7%  ↑↑         │
│  ██████            Rhinos             8.2%  ↓           │
│  ████              Living End         5.1%  →          │
│  ...                                                    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ⚡ "Energy is surging — here's what that means   │  │
│  │    for your RCQ prep this weekend."              │  │
│  │                           [Ask the Firemind →]   │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- Filters: time range (7d / 30d / 90d / all), sort by meta share or win rate
- Archetype rows are tappable → `/data/[format]/[archetype]`
- Oracle summary card at bottom: cached synthesis, CTA to oracle
- OG image: "Modern Metagame — [date]" with top 3 archetypes

---

### `/data/[format]/[archetype]` — Archetype detail

Public, SSR, fully crawlable. The main SEO surface and conversion page.

```
┌─────────────────────────────────────────────────────────┐
│  Modern › Boros Energy                                  │
│  Tier 1 · 9.7% meta share · 54.2% win rate             │
│                                                         │
│  Meta share (30d)   [▁▂▃▄▅▇▇▇▇█]                       │
│  Win rate   (30d)   [▄▄▅▅▅▆▆▅▆▆]                       │
│                                                         │
│  Recent results                                         │
│  Mar 1  MTGO Showcase  1st   Pilot: Aspiringspike       │
│  Feb 28 MTGO Prelim    3rd   Pilot: kanister            │
│  Feb 26 MTGO Prelim    2nd   Pilot: ...                 │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  ⚡ Ask the Firemind about Boros Energy    [→]   │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  [Generate sample deck list]          — Spike only      │
│  [Sideboard plan vs the field]        — Spike only      │
│  [🔔 Alert me when this top 8s]       — 1 free / ∞ Spike│
└─────────────────────────────────────────────────────────┘
```

- "Ask the Firemind" CTA uses the free query quota — accessible to all
- Deck list generation and sideboard CTAs are Spike-only, shown with upgrade prompt if Casual
- OG image: archetype name, format, meta %, trend arrow
- Shareable oracle result permalink when oracle is invoked from this page

---

### `/reports/[format]-[date]` — Public meta reports

Weekly digest published as a public SSR page. Fully indexed — SEO compound value.
Same content as the Spike email digest. Canonical URL included in the digest email.

---

### `/chat/results/[id]` — Shareable oracle result

Public permalink to a single oracle response (not a full conversation).
Shows: the query, the response, archetype/format context, timestamp.
Social share buttons. CTA: "Get your own oracle queries — it's free."

---

### `/pricing` — Standalone pricing page

Casual vs Spike side-by-side. Linkable from emails, social, Discord.
FAQ: "Are the charts always free?" "Can I cancel anytime?"

---

### `/settings` — Account

Profile, auth connections, subscription + Stripe billing portal, query usage this period.

---

## Feature gating pattern

Locked Spike features appear inline with a contextual upgrade prompt — never a full-page block.

```
[Generate sample deck list]
"Unlock deck generation with Spike — $4.99/mo"   [Upgrade]
```

The free "Ask the Firemind" CTA always appears first and is always tappable,
giving Casual users a taste of the oracle before hitting the harder Spike gates.
