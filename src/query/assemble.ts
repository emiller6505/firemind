import type { Intent } from './intent'
import type { RetrievedData, DeckSummary } from './retrieval'
import { rcqPromptNote } from '../lib/rcq-schedule'

export function assembleContext(intent: Intent, data: RetrievedData): string {
  const lines: string[] = []

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
- Do not fabricate cards, placements, or results.
- Do not use emojis.
- When the user asks about budget, affordability, or cheapest options: rank decks by their paper cost or tix cost shown in the deck header, whichever is relevant. If cost data is absent for a deck, note that prices weren't available.
- RCQ format awareness: use the current RCQ season format noted below when answering questions about RCQs. If the user asks about RCQs but the format is ambiguous and not clear from context, ask them to clarify which format they mean before answering.`

export function buildResponseSystem(): string {
  return `${RESPONSE_SYSTEM_BASE}\n\n${rcqPromptNote()}`
}
