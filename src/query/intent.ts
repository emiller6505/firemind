import { llm } from '../lib/llm'
import { rcqPromptNote } from '../lib/rcq-schedule'

export interface Intent {
  format: 'modern' | 'standard' | null
  question_type: 'metagame' | 'deck_advice' | 'card_question' | 'matchup' | 'general'
  archetype: string | null      // primary archetype mentioned
  archetype_b: string | null    // second archetype (matchup questions only)
  card: string | null           // specific card name (card_question only)
  timeframe_days: 30 | 60 | 90  // lookback window; default 90
}

const SYSTEM_BASE = `You are a Magic: the Gathering query parser. Extract structured intent from the user's question.

Return ONLY valid JSON matching this exact schema — no prose, no markdown, no code fences:

{
  "format": "modern" | "standard" | null,
  "question_type": "metagame" | "deck_advice" | "card_question" | "matchup" | "general",
  "archetype": string | null,
  "archetype_b": string | null,
  "card": string | null,
  "timeframe_days": 30 | 60 | 90
}

Rules:
- format: infer from context ("rotation" or "Standard" → "standard", "Modern" → "modern"). For RCQ questions, use the current RCQ season format noted below — do NOT default to modern. null if still ambiguous.
- question_type: "metagame" = meta share/tier questions, "deck_advice" = what to play/build, "card_question" = specific card usage/value, "matchup" = archetype vs archetype, "general" = anything else.
- archetype: normalize to a common name (e.g. "Izzet Murktide" not "blue-red tempo"). null if not mentioned.
- archetype_b: only for matchup questions; null otherwise.
- card: canonical card name if this is a card question; null otherwise.
- timeframe_days: default 90. Use 30 if "this week", "recent", or "right now" is emphasized.`

const VALID_FORMATS = new Set(['modern', 'standard'])
const VALID_TIMEFRAMES = new Set([30, 60, 90])
const VALID_QUESTION_TYPES = new Set(['metagame', 'deck_advice', 'card_question', 'matchup', 'general'])

function normalizeIntent(raw: Record<string, unknown>): Intent {
  const format = VALID_FORMATS.has(raw.format as string) ? (raw.format as Intent['format']) : null
  const question_type = VALID_QUESTION_TYPES.has(raw.question_type as string)
    ? (raw.question_type as Intent['question_type'])
    : 'general'
  const timeframe_days = VALID_TIMEFRAMES.has(raw.timeframe_days as number)
    ? (raw.timeframe_days as Intent['timeframe_days'])
    : 90
  return {
    format,
    question_type,
    archetype: typeof raw.archetype === 'string' ? raw.archetype : null,
    archetype_b: typeof raw.archetype_b === 'string' ? raw.archetype_b : null,
    card: typeof raw.card === 'string' ? raw.card : null,
    timeframe_days,
  }
}

export async function extractIntent(query: string): Promise<Intent> {
  const system = `${SYSTEM_BASE}\n\n${rcqPromptNote()}`
  const raw = await llm.complete(system, query, { maxTokens: 256, temperature: 0 })
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(cleaned)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return normalizeIntent(parsed as Record<string, unknown>)
  } catch {
    throw new Error(`Intent parse failed. Raw response: ${raw}`)
  }
}
