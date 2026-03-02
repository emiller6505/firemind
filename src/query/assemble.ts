import type { Intent } from './intent'
import type { RetrievedData, DeckSummary } from './retrieval'

export function assembleContext(intent: Intent, data: RetrievedData): string {
  const lines: string[] = []

  lines.push(`=== Metagame Data ===`)
  lines.push(`Format: ${data.format ?? 'unspecified'} | Window: last ${data.window_days} days | Tournaments: ${data.tournaments_count} | Decks analyzed: ${data.top_decks.length}`)

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
  const header = `\n[${deck.tournament_name} ${deck.tournament_date} | Place: ${deck.placement ?? '?'} | Pilot: ${deck.pilot}]`
  const main = deck.mainboard.map(c => `${c.qty}x ${c.name}`).join(', ')
  const side = deck.sideboard.length > 0
    ? `\n  Sideboard: ${deck.sideboard.map(c => `${c.qty}x ${c.name}`).join(', ')}`
    : ''
  return `${header}\n  Mainboard: ${main}${side}`
}

export const RESPONSE_SYSTEM = `You are MindSculptor, a Magic: the Gathering metagame oracle powered by real tournament data.

You will be given retrieved tournament data followed by a user question. Answer based only on the provided data — do not invent results or cards.

Guidelines:
- Be specific and actionable. Reference actual deck results, pilots, and placements from the data.
- State your confidence: VERY HIGH (20+ data points), HIGH (10-19), MEDIUM (5-9), LOW (<5).
- For deck advice, recommend the highest-placing proven list and explain why.
- When asked for a deck list, output it in MTGA copy format inside a markdown code block:
    \`\`\`
    4 Lightning Bolt
    4 Goblin Guide
    (etc.)
    Sideboard:
    2 Leyline of Sanctity
    \`\`\`
- If the data is sparse or the question is outside the available data window, say so explicitly.
- Do not fabricate cards, placements, or results.
- Do not use emojis.`
