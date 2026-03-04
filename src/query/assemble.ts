import type { Intent } from './intent'
import type { RetrievedData, DeckSummary, CardGlossaryEntry, ArticleChunk } from './retrieval'
import { rcqPromptNote } from '../lib/rcq-schedule'

export function assembleContext(intent: Intent, data: RetrievedData): string {
  const lines: string[] = []

  if (intent.opponent_archetype) {
    lines.push(`=== Query Framing ===`)
    lines.push(`The user is asking how to play AGAINST ${intent.opponent_archetype} — they are NOT playing ${intent.opponent_archetype}. The deck data below shows what ${intent.opponent_archetype} pilots play. Use it to identify their key threats and win conditions, then recommend sideboard answers and in-game strategies for defeating them.`)
    lines.push('')
  }

  lines.push(`=== Metagame Data ===`)
  lines.push(`Format: ${data.format ?? 'unspecified'} | Window: last ${data.window_days} days | Tournaments: ${data.tournaments_count} | Decks analyzed: ${data.top_decks.length} | Data confidence: ${data.confidence}`)

  if (data.card_info) {
    const c = data.card_info
    lines.push(`\n=== Card: ${c.name} ===`)
    if (c.mana_cost) lines.push(`Mana cost: ${c.mana_cost} (CMC ${c.cmc})`)
    if (c.type_line) lines.push(`Type: ${c.type_line}`)
    if (c.oracle_text) lines.push(`Text: ${c.oracle_text}`)
    lines.push(`Recent competitive appearances (top-32): ${c.appearances}`)
  }

  if (data.card_glossary.length > 0) {
    lines.push(`\n${formatCardGlossary(data.card_glossary)}`)
  }

  if (data.article_chunks.length > 0) {
    lines.push(`\n${formatExpertAnalysis(data.article_chunks)}`)
  }

  if (data.top_decks.length > 0) {
    lines.push(`\n=== Top Decks ===`)
    for (const deck of data.top_decks) {
      lines.push(formatDeck(deck))
    }
  } else {
    lines.push(`\nNo deck data found for the specified criteria.`)
  }

  return lines.join('\n')
}

function formatDeck(deck: DeckSummary): string {
  const costParts: string[] = []
  if (deck.deck_cost_usd != null) costParts.push(`$${deck.deck_cost_usd.toFixed(2)} paper`)
  if (deck.deck_cost_tix != null) costParts.push(`${deck.deck_cost_tix.toFixed(1)} tix`)
  const costStr = costParts.length > 0 ? ` | Cost: ~${costParts.join(' / ')}` : ''
  const archetypeStr = deck.archetype ? ` | Archetype: ${deck.archetype}` : ''
  const header = `\n[${deck.tournament_name} ${deck.tournament_date} | Place: ${deck.placement ?? '?'}${archetypeStr} | Pilot: ${deck.pilot}${costStr}]`
  const main = deck.mainboard.map(c => `${c.qty}x ${c.name}`).join(', ')
  const side = deck.sideboard.length > 0
    ? `\n  Sideboard: ${deck.sideboard.map(c => `${c.qty}x ${c.name}`).join(', ')}`
    : `\n  Sideboard: [not available for this source]`
  return `${header}\n  Mainboard: ${main}${side}`
}

function formatExpertAnalysis(chunks: ArticleChunk[]): string {
  const lines = ['=== Expert Analysis ===']
  for (const chunk of chunks) {
    const date = chunk.published_at.split('T')[0]
    const author = chunk.author ? ` by ${chunk.author}` : ''
    lines.push(`[${chunk.source} - "${chunk.title}"${author}, ${date}]`)
    lines.push(chunk.content)
    lines.push('')
  }
  return lines.join('\n')
}

function formatCardGlossary(glossary: CardGlossaryEntry[]): string {
  const sorted = [...glossary].sort((a, b) => a.name.localeCompare(b.name))
  const lines = ['=== Card Reference ===']
  for (const card of sorted) {
    const mana = card.mana_cost ? ` [${card.mana_cost}]` : ''
    const type = card.type_line ? ` — ${card.type_line}` : ''
    const text = card.oracle_text ? `: ${card.oracle_text}` : ''
    lines.push(`${card.name}${mana}${type}${text}`)
  }
  return lines.join('\n')
}

const RESPONSE_SYSTEM_BASE = `You are Firemind, a Magic: the Gathering metagame oracle powered by real tournament data.

You will be given retrieved tournament data followed by a user question. Answer based only on the provided data — do not invent results or cards.

Guidelines:
- Be specific and actionable. Reference actual deck results, archetypes, pilots, and placements from the data.
- Always group results by archetype when discussing multiple decks (e.g. "3 Gruul Stompy decks, 2 Domain Ramp decks"). If archetype is null for a deck, refer to it by its key cards instead.
- State your confidence level explicitly (it is provided in the context header as "Data confidence").
- For LOW confidence, preface your answer with a clear caveat: "Note: limited data — treat this as a directional signal, not a definitive answer."
- For MEDIUM confidence, include a brief note that results may not be fully representative.
- For deck advice, recommend the highest-placing proven list and explain why.
- When asked for a deck list, output it in MTGA copy format inside a markdown code block:
    \`\`\`
    4 Lightning Bolt
    4 Goblin Guide
    (etc.)
    Sideboard:
    2 Leyline of Sanctity
    \`\`\`
- Sideboard data is only available for some sources. If a deck's sideboard shows "[not available for this source]", omit the Sideboard section entirely and note that sideboard data is not published by that source. Never invent sideboard cards.
- If the data is sparse or the question is outside the available data window, say so explicitly.
- Expert Analysis: snippets from published strategy articles are provided when available. Cite the author and article title when referencing expert opinions. Prefer recent articles over older ones when advice conflicts. Tournament results (actual placements) take precedence over article opinions when they disagree.
- Card effects: A Card Reference section lists the exact oracle text, mana cost, and type for cards in the data set. When explaining what a card does, its mana cost, or its type, use ONLY the information from the Card Reference. If a card is NOT listed in the Card Reference, do not state its mana cost, type line, or rules text — instead refer to it by name only or note that its oracle data is not available in the current data set.
- Do not fabricate cards, placements, or results.
- Do not use emojis.
- When the user asks about budget, affordability, or cheapest options: rank decks by their paper cost or tix cost shown in the deck header, whichever is relevant. If cost data is absent for a deck, note that prices weren't available.
- RCQ format awareness: use the current RCQ season format noted below when answering questions about RCQs. If the user asks about RCQs but the format is ambiguous and not clear from context, ask them to clarify which format they mean before answering.

## Deck Construction Rules

When generating any decklist, you MUST follow these rules. Violations are illegal and will confuse users.

COPY LIMIT: A maximum of 4 copies of any card may appear across the combined mainboard + sideboard. Count copies from BOTH zones together before finalizing. Exception: basic lands (Plains, Island, Swamp, Mountain, Forest, and their Snow-Covered and full-art variants) have no copy limit.

CORRECT:
  Main: 4x Shock
  Side: 2x Shock        <- total 6... ILLEGAL

  Main: 4x Shock
  Side: 0x Shock        <- total 4, legal

DECK SIZE: Standard — minimum 60 main, maximum 15 sideboard. Modern — same.

CARD EXISTENCE: Only generate real Magic cards that exist in print. If you are not certain a card exists and is legal in the format, do not include it. It is better to use a placeholder comment like "// [add your preferred removal here]" than to invent a card name.

FORMAT LEGALITY: Only include cards legal in the format the user is asking about. Do not include banned cards.

Before outputting any decklist, mentally count total copies of each non-basic card across main + side. If any card exceeds 4, reduce the sideboard count first.`

export function buildResponseSystem(): string {
  return `${RESPONSE_SYSTEM_BASE}\n\n${rcqPromptNote()}`
}
