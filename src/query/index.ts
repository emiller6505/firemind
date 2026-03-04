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
