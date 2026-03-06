import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

const { MockAPIError, mockCreate, mockStream } = vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  class MockAPIError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return { MockAPIError, mockCreate: vi.fn(), mockStream: vi.fn() }
})

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: mockCreate, stream: mockStream }
    static APIError = MockAPIError
  }
  return { default: Anthropic }
})

import { llm } from '../llm'

function okResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function streamEvents(text: string) {
  const events = [...text].map(ch => ({
    type: 'content_block_delta' as const,
    delta: { type: 'text_delta' as const, text: ch },
  }))
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

async function collectStream(iter: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of iter) out += chunk
  return out
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── complete() ──────────────────────────────────────────────────────────────────

describe('complete retry on rate limit', () => {
  it('returns on first try without retrying', async () => {
    mockCreate.mockResolvedValue(okResponse('hello'))

    const result = await llm.complete('sys', 'usr')

    expect(result).toBe('hello')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 and succeeds', async () => {
    let calls = 0
    mockCreate.mockImplementation(() => {
      if (++calls < 2) throw new MockAPIError(429, 'rate limited')
      return Promise.resolve(okResponse('recovered'))
    })

    const promise = llm.complete('sys', 'usr')
    await vi.advanceTimersByTimeAsync(2000)

    expect(await promise).toBe('recovered')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('retries on 529 (overloaded)', async () => {
    let calls = 0
    mockCreate.mockImplementation(() => {
      if (++calls < 2) throw new MockAPIError(529, 'overloaded')
      return Promise.resolve(okResponse('recovered'))
    })

    const promise = llm.complete('sys', 'usr')
    await vi.advanceTimersByTimeAsync(2000)

    expect(await promise).toBe('recovered')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 400', async () => {
    mockCreate.mockImplementation(() => { throw new MockAPIError(400, 'bad request') })
    await expect(llm.complete('sys', 'usr')).rejects.toThrow('bad request')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 401', async () => {
    mockCreate.mockImplementation(() => { throw new MockAPIError(401, 'unauthorized') })
    await expect(llm.complete('sys', 'usr')).rejects.toThrow('unauthorized')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 500', async () => {
    mockCreate.mockImplementation(() => { throw new MockAPIError(500, 'internal') })
    await expect(llm.complete('sys', 'usr')).rejects.toThrow('internal')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-API errors', async () => {
    mockCreate.mockImplementation(() => { throw new Error('network down') })
    await expect(llm.complete('sys', 'usr')).rejects.toThrow('network down')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting 3 retries (4 total attempts)', async () => {
    mockCreate.mockImplementation(() => { throw new MockAPIError(429, 'rate limited') })

    const result = llm.complete('sys', 'usr').catch((e: Error) => e)
    // backoffs: 2s + 4s + 8s = 14s
    await vi.advanceTimersByTimeAsync(15_000)

    const err = await result
    expect(err).toBeInstanceOf(MockAPIError)
    expect((err as MockAPIError).status).toBe(429)
    expect(mockCreate).toHaveBeenCalledTimes(4)
  })

  it('applies exponential backoff: 2s, 4s, 8s', async () => {
    let calls = 0
    mockCreate.mockImplementation(() => {
      if (++calls < 4) throw new MockAPIError(429, 'rate limited')
      return Promise.resolve(okResponse('finally'))
    })

    const promise = llm.complete('sys', 'usr')

    // Before first backoff elapses — still just 1 attempt
    await vi.advanceTimersByTimeAsync(1999)
    expect(mockCreate).toHaveBeenCalledTimes(1)

    // First backoff (2s) fires retry 1
    await vi.advanceTimersByTimeAsync(1)
    expect(mockCreate).toHaveBeenCalledTimes(2)

    // Second backoff (4s) fires retry 2
    await vi.advanceTimersByTimeAsync(4000)
    expect(mockCreate).toHaveBeenCalledTimes(3)

    // Third backoff (8s) fires retry 3
    await vi.advanceTimersByTimeAsync(8000)
    expect(mockCreate).toHaveBeenCalledTimes(4)

    expect(await promise).toBe('finally')
  })
})

// ── onRetry callback ────────────────────────────────────────────────────────────

describe('onRetry callback', () => {
  it('fires exactly once on first retry attempt', async () => {
    const onRetry = vi.fn()
    let calls = 0
    mockCreate.mockImplementation(() => {
      if (++calls < 3) throw new MockAPIError(429, 'rate limited')
      return Promise.resolve(okResponse('ok'))
    })

    const promise = llm.complete('sys', 'usr', { onRetry })
    await vi.advanceTimersByTimeAsync(7000)
    await promise

    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not fire when call succeeds on first try', async () => {
    const onRetry = vi.fn()
    mockCreate.mockImplementation(() => Promise.resolve(okResponse('ok')))

    await llm.complete('sys', 'usr', { onRetry })

    expect(onRetry).not.toHaveBeenCalled()
  })

  it('does not fire on non-retryable errors', async () => {
    const onRetry = vi.fn()
    mockCreate.mockImplementation(() => { throw new MockAPIError(400, 'bad') })

    await expect(llm.complete('sys', 'usr', { onRetry })).rejects.toThrow()
    expect(onRetry).not.toHaveBeenCalled()
  })
})

// ── completeWithHistory() ───────────────────────────────────────────────────────

describe('completeWithHistory retry', () => {
  it('retries on 429 and succeeds', async () => {
    let calls = 0
    mockCreate.mockImplementation(() => {
      if (++calls < 2) throw new MockAPIError(429, 'rate limited')
      return Promise.resolve(okResponse('history answer'))
    })

    const promise = llm.completeWithHistory('sys', [{ role: 'user', content: 'hi' }])
    await vi.advanceTimersByTimeAsync(2000)

    expect(await promise).toBe('history answer')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})

// ── completeStream() ────────────────────────────────────────────────────────────

describe('completeStream retry', () => {
  it('streams successfully without retry', async () => {
    mockStream.mockReturnValue(streamEvents('hi'))

    const result = await collectStream(llm.completeStream('sys', 'usr'))

    expect(result).toBe('hi')
    expect(mockStream).toHaveBeenCalledTimes(1)
  })

  it('retries stream creation on 429 and recovers', async () => {
    mockStream
      .mockImplementationOnce(() => { throw new MockAPIError(429, 'rate limited') })
      .mockReturnValue(streamEvents('recovered'))

    const promise = (async () => collectStream(llm.completeStream('sys', 'usr')))()
    await vi.advanceTimersByTimeAsync(2000)

    expect(await promise).toBe('recovered')
    expect(mockStream).toHaveBeenCalledTimes(2)
  })

  it('fires onRetry on stream rate limit', async () => {
    const onRetry = vi.fn()
    mockStream
      .mockImplementationOnce(() => { throw new MockAPIError(429, 'rate limited') })
      .mockReturnValue(streamEvents('ok'))

    const promise = (async () => collectStream(llm.completeStream('sys', 'usr', { onRetry })))()
    await vi.advanceTimersByTimeAsync(2000)
    await promise

    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not retry stream on non-retryable errors', async () => {
    mockStream.mockImplementationOnce(() => { throw new MockAPIError(400, 'bad') })

    await expect(
      (async () => collectStream(llm.completeStream('sys', 'usr')))()
    ).rejects.toThrow('bad')
    expect(mockStream).toHaveBeenCalledTimes(1)
  })
})

// ── completeStreamWithHistory() ─────────────────────────────────────────────────

describe('completeStreamWithHistory retry', () => {
  it('retries on 429 and streams successfully', async () => {
    mockStream
      .mockImplementationOnce(() => { throw new MockAPIError(429, 'rate limited') })
      .mockReturnValue(streamEvents('history stream'))

    const promise = (async () =>
      collectStream(llm.completeStreamWithHistory('sys', [{ role: 'user', content: 'hi' }]))
    )()
    await vi.advanceTimersByTimeAsync(2000)

    expect(await promise).toBe('history stream')
    expect(mockStream).toHaveBeenCalledTimes(2)
  })
})
