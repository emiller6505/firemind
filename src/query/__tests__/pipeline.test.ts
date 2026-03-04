import { vi, describe, it, expect, beforeEach } from 'vitest'
import { INTENT_FIXTURE, DECK_SUMMARY_FIXTURE } from './helpers.js'

vi.mock('../../lib/llm.js', () => ({ llm: { complete: vi.fn(), completeWithHistory: vi.fn() } }))
vi.mock('../intent.js', () => ({ extractIntent: vi.fn() }))
vi.mock('../retrieval.js', () => ({ retrieveContext: vi.fn() }))
vi.mock('../../lib/query-cache', () => ({ cacheGet: vi.fn().mockReturnValue(null), cacheSet: vi.fn() }))

import { llm } from '../../lib/llm.js'
import { extractIntent } from '../intent.js'
import { retrieveContext } from '../retrieval.js'
import { handleQuery } from '../index.js'

const RETRIEVED_DATA = {
  format: 'modern',
  window_days: 90,
  tournaments_count: 2,
  top_decks: [DECK_SUMMARY_FIXTURE],
  card_info: null,
  confidence: 'HIGH' as const,
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(extractIntent).mockResolvedValue(INTENT_FIXTURE)
  vi.mocked(retrieveContext).mockResolvedValue(RETRIEVED_DATA)
  vi.mocked(llm.complete).mockResolvedValue('Burn is the best deck right now.')
  vi.mocked(llm.completeWithHistory).mockResolvedValue('Burn is still the best deck.')
})

describe('handleQuery (full pipeline)', () => {
  it('returns a response with answer, intent, and data', async () => {
    const result = await handleQuery('What is the best Modern deck?')

    expect(result.answer).toBe('Burn is the best deck right now.')
    expect(result.intent).toEqual(INTENT_FIXTURE)
    expect(result.data).toEqual(RETRIEVED_DATA)
  })

  it('passes the user query to extractIntent', async () => {
    const query = 'What should I play at an RCQ?'
    await handleQuery(query)

    expect(extractIntent).toHaveBeenCalledWith(query)
  })

  it('passes the extracted intent to retrieveContext', async () => {
    await handleQuery('test')

    expect(retrieveContext).toHaveBeenCalledWith(INTENT_FIXTURE, expect.anything())
  })

  it('calls llm.complete exactly once for the final response', async () => {
    await handleQuery('test')

    expect(llm.complete).toHaveBeenCalledTimes(1)
  })

  it('includes the user query in the LLM user message', async () => {
    const query = 'Should I play Burn or Tron in Modern?'
    await handleQuery(query)

    const [, userMsg] = vi.mocked(llm.complete).mock.calls[0]
    expect(userMsg).toContain(query)
  })

  it('includes retrieved deck data in the LLM user message', async () => {
    await handleQuery('test')

    const [, userMsg] = vi.mocked(llm.complete).mock.calls[0]
    expect(userMsg).toContain('gerry_t')         // pilot from DECK_FIXTURE
    expect(userMsg).toContain('Lightning Bolt')   // card from mainboard
  })

  it('uses a system prompt that mentions the oracle role', async () => {
    await handleQuery('test')

    const [systemMsg] = vi.mocked(llm.complete).mock.calls[0]
    expect(systemMsg).toContain('Firemind')
  })
})

describe('handleQuery with history', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'What is the best Modern deck?' },
    { role: 'assistant' as const, content: 'Burn is the best deck right now.' },
  ]

  it('calls completeWithHistory not complete when history is provided', async () => {
    await handleQuery('Is that still true?', HISTORY)

    expect(llm.completeWithHistory).toHaveBeenCalledTimes(1)
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('passes history messages plus assembled user msg to completeWithHistory', async () => {
    const query = 'Is that still true?'
    await handleQuery(query, HISTORY)

    const [, messages] = vi.mocked(llm.completeWithHistory).mock.calls[0]
    expect(messages[0]).toEqual(HISTORY[0])
    expect(messages[1]).toEqual(HISTORY[1])
    expect(messages[2].role).toBe('user')
    expect(messages[2].content).toContain(query)
  })

  it('still calls extractIntent with only the current query', async () => {
    const query = 'Is that still true?'
    await handleQuery(query, HISTORY)

    expect(extractIntent).toHaveBeenCalledWith(query)
    expect(extractIntent).toHaveBeenCalledTimes(1)
  })

  it('falls back to llm.complete when history is empty', async () => {
    await handleQuery('test', [])

    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(llm.completeWithHistory).not.toHaveBeenCalled()
  })
})
