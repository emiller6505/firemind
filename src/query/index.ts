import { llm } from '../lib/llm'
import { Trace } from '../lib/trace'
import { extractIntent } from './intent'
import { retrieveContext } from './retrieval'
import { assembleContext, buildResponseSystem } from './assemble'
import { cacheGet, cacheSet } from '../lib/query-cache'
import type { Intent } from './intent'
import type { RetrievedData } from './retrieval'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export type ConversationMessage = { role: 'user' | 'assistant'; content: string }

export interface QueryResponse {
  answer: string
  intent: Intent
  data: RetrievedData
}


export async function handleQuery(userQuery: string, history: ConversationMessage[] = []): Promise<QueryResponse> {
  const key = userQuery.trim().toLowerCase()
  const cached = cacheGet<QueryResponse>(key)
  if (cached) {
    await sleep(1000)
    return cached
  }

  const trace = new Trace('handleQuery')

  const intent = await trace.time('extractIntent', () => extractIntent(userQuery))
  const data = await trace.time('retrieveContext', () => retrieveContext(intent, trace))
  const context = assembleContext(intent, data)

  const userMsg = `Retrieved data:\n${context}\n\nUser question: ${userQuery}`
  const system = buildResponseSystem()

  let answer: string
  if (history.length > 0) {
    answer = await trace.time('llm.completeWithHistory', () =>
      llm.completeWithHistory(system, [...history, { role: 'user', content: userMsg }], { maxTokens: 2048 }),
    )
  } else {
    answer = await trace.time('llm.complete', () =>
      llm.complete(system, userMsg, { maxTokens: 2048 }),
    )
  }

  trace.finish()

  const result: QueryResponse = { answer, intent, data }
  cacheSet(key, result)
  return result
}

export async function streamPipeline(
  query: string,
  history: ConversationMessage[],
  rateLimit: unknown,
  emit: (event: string, data: unknown) => void,
): Promise<{ intent: Intent; data: RetrievedData; fullAnswer: string }> {
  const trace = new Trace('streamPipeline')

  // Stage 1: intent
  emit('progress', { stage: 'intent', pct: 10, label: 'Understanding your question…' })
  const intent = await trace.time('extractIntent', () => extractIntent(query))

  // Stage 2: retrieval
  const formatLabel = intent.format
    ? `${intent.format.charAt(0).toUpperCase() + intent.format.slice(1)} tournament`
    : 'tournament'
  emit('progress', { stage: 'retrieval', pct: 30, label: `Scanning ${formatLabel} results…` })
  const data = await trace.time('retrieveContext', () => retrieveContext(intent, trace))

  // Stage 3: generating — real deck/tourney counts
  const deckCount = data.top_decks.length
  const tourneyCount = data.tournaments_count
  const draftLabel = deckCount > 0
    ? `Analyzing ${deckCount} deck${deckCount !== 1 ? 's' : ''} from ${tourneyCount} tournament${tourneyCount !== 1 ? 's' : ''}…`
    : 'Drafting response…'
  emit('progress', { stage: 'generating', pct: 55, label: draftLabel })

  const context = assembleContext(intent, data)
  const userMsg = `Retrieved data:\n${context}\n\nUser question: ${query}`
  const system = buildResponseSystem()

  emit('meta', { intent, data, rate_limit: rateLimit })

  // Stage 4: LLM streaming
  emit('progress', { stage: 'streaming', label: 'Writing…' })

  const stream = history.length > 0
    ? llm.completeStreamWithHistory(system, [...history, { role: 'user', content: userMsg }], { maxTokens: 2048 })
    : llm.completeStream(system, userMsg, { maxTokens: 2048 })

  let fullAnswer = ''
  for await (const chunk of stream) {
    fullAnswer += chunk
    emit('delta', { text: chunk })
  }

  trace.finish()
  return { intent, data, fullAnswer }
}

