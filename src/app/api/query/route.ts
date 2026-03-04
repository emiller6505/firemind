import { NextRequest, NextResponse } from 'next/server'
import { handleQueryStream } from '@/query/index'
import type { ConversationMessage } from '@/query/index'
import { cacheGet, cacheSet } from '@/lib/query-cache'
import type { QueryResponse } from '@/query/index'
import { createClient } from '@/lib/supabase-server'
import { parseDecklist, validateDecklist, formatValidationWarning } from '@/query/decklist'
import { USER_LIMIT, WINDOW_MS } from '@/lib/rate-limit-constants'

const MAX_HISTORY = 6

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.query || typeof body.query !== 'string') {
    return NextResponse.json({ error: 'query string is required' }, { status: 400 })
  }
  if (body.query.length > 1000) {
    return NextResponse.json({ error: 'query too long (max 1000 chars)' }, { status: 400 })
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const history: ConversationMessage[] = rawMessages
    .filter((m: unknown) => m && typeof (m as Record<string, unknown>).role === 'string' && typeof (m as Record<string, unknown>).content === 'string')
    .slice(-MAX_HISTORY)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let currentCount = 0
  let resetsAt: string | null = null
  let windowExpired = true
  let existingWindowStart: string | null = null

  if (user) {
    const now = Date.now()
    const { data: row } = await supabase
      .from('oracle_queries')
      .select('count, window_start')
      .eq('user_id', user.id)
      .single()

    if (row?.window_start && now - new Date(row.window_start).getTime() < WINDOW_MS) {
      windowExpired = false
      currentCount = row.count
      existingWindowStart = row.window_start
      resetsAt = new Date(new Date(row.window_start).getTime() + WINDOW_MS).toISOString()
    }

    if (currentCount >= USER_LIMIT) {
      return NextResponse.json({
        error: 'rate_limit_exceeded',
        rate_limit: { remaining: 0, resets_at: resetsAt, tier: 'user' },
      }, { status: 429 })
    }
  }

  const key = body.query.trim().toLowerCase()
  const cached = cacheGet<QueryResponse>(key)

  if (cached) {
    if (user) {
      const upsertData = windowExpired
        ? { user_id: user.id, count: 1, window_start: new Date().toISOString() }
        : { user_id: user.id, count: currentCount + 1, window_start: existingWindowStart! }
      await supabase.from('oracle_queries').upsert(upsertData, { onConflict: 'user_id' })
      if (windowExpired) resetsAt = new Date(Date.now() + WINDOW_MS).toISOString()
    }

    const rateLimit = user
      ? { remaining: USER_LIMIT - currentCount - 1, resets_at: resetsAt, tier: 'user' }
      : { remaining: null, resets_at: null, tier: 'anon' }

    const readable = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(sseEvent('meta', { intent: cached.intent, data: cached.data, rate_limit: rateLimit })))
        controller.enqueue(encoder.encode(sseEvent('delta', { text: cached.answer })))

        const parsed = parseDecklist(cached.answer)
        if (parsed) {
          const errors = validateDecklist(parsed.main, parsed.side)
          if (errors.length > 0) {
            controller.enqueue(encoder.encode(sseEvent('decklist_warning', { errors, message: formatValidationWarning(errors) })))
          }
        }

        controller.enqueue(encoder.encode(sseEvent('done', {})))
        controller.close()
      },
    })

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    })
  }

  try {
    const result = await handleQueryStream(body.query, history)

    if (user && windowExpired) resetsAt = new Date(Date.now() + WINDOW_MS).toISOString()

    const rateLimit = user
      ? { remaining: USER_LIMIT - currentCount - 1, resets_at: resetsAt, tier: 'user' }
      : { remaining: null, resets_at: null, tier: 'anon' }

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(sseEvent('meta', { intent: result.intent, data: result.data, rate_limit: rateLimit })))

        let fullAnswer = ''
        try {
          for await (const chunk of result.stream) {
            fullAnswer += chunk
            controller.enqueue(encoder.encode(sseEvent('delta', { text: chunk })))
          }
          const parsed = parseDecklist(fullAnswer)
          if (parsed) {
            const errors = validateDecklist(parsed.main, parsed.side)
            if (errors.length > 0) {
              controller.enqueue(encoder.encode(sseEvent('decklist_warning', { errors, message: formatValidationWarning(errors) })))
            }
          }

          controller.enqueue(encoder.encode(sseEvent('done', {})))

          cacheSet(key, { answer: fullAnswer, intent: result.intent, data: result.data })

          if (user) {
            const upsertData = windowExpired
              ? { user_id: user.id, count: 1, window_start: new Date().toISOString() }
              : { user_id: user.id, count: currentCount + 1, window_start: existingWindowStart! }
            await supabase.from('oracle_queries').upsert(upsertData, { onConflict: 'user_id' })
          }
        } catch (err) {
          console.error('[api/query] stream error', err)
          controller.enqueue(encoder.encode(sseEvent('error', { error: 'Stream failed' })))
        } finally {
          controller.close()
        }
      },
    })

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    })
  } catch (err) {
    console.error('[api/query]', err)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}
