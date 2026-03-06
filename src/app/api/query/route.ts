import { NextRequest, NextResponse } from 'next/server'
import { streamPipeline } from '@/query/index'
import type { ConversationMessage, QueryResponse } from '@/query/index'
import { cacheGet, cacheSet } from '@/lib/query-cache'
import { createClient } from '@/lib/supabase-server'
import { parseDecklist, validateDecklist, formatValidationWarning, fixCopyLimits, renderDecklist } from '@/query/decklist'
import { USER_LIMIT, WINDOW_MS } from '@/lib/rate-limit-constants'
import { checkCircuitBreaker } from '@/lib/circuit-breaker'
import { checkIpLimit } from '@/lib/ip-rate-limit'
import { getClientIp } from '@/lib/get-client-ip'
import { acquireConnection, releaseConnection } from '@/lib/connection-limiter'
import { checkBlocklist } from '@/lib/query-blocklist'
import { isAllowedOrigin, corsHeaders } from '@/lib/cors'
import { createHash } from 'crypto'

const MAX_HISTORY = 6
const MAX_MESSAGES = 50
const MAX_MESSAGE_LENGTH = 2000

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin')
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

export async function POST(req: NextRequest) {
  // --- CORS ---
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // --- Input validation ---
  const body = await req.json().catch(() => null)
  if (!body?.query || typeof body.query !== 'string') {
    return NextResponse.json({ error: 'query string is required' }, { status: 400, headers: cors })
  }
  if (body.query.length > 1000) {
    return NextResponse.json({ error: 'query too long (max 1000 chars)' }, { status: 400, headers: cors })
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  if (rawMessages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: 'too many messages' }, { status: 400, headers: cors })
  }
  const history: ConversationMessage[] = rawMessages
    .filter((m: unknown) => {
      if (!m || typeof (m as Record<string, unknown>).role !== 'string' || typeof (m as Record<string, unknown>).content !== 'string') return false
      return (m as Record<string, unknown>).content!.toString().length <= MAX_MESSAGE_LENGTH
    })
    .slice(-MAX_HISTORY)

  // --- Prompt injection blocklist ---
  const blockResult = checkBlocklist(body.query)
  if (blockResult.blocked) {
    return NextResponse.json({ error: 'query contains blocked content' }, { status: 400, headers: cors })
  }
  for (const msg of history) {
    if (checkBlocklist(msg.content).blocked) {
      return NextResponse.json({ error: 'message contains blocked content' }, { status: 400, headers: cors })
    }
  }

  // --- Circuit breaker ---
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!(await checkCircuitBreaker(supabase))) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable — daily query limit reached' },
      { status: 503, headers: cors },
    )
  }

  // --- IP rate limit (all requests) ---
  const ip = getClientIp(req)
  if (!checkIpLimit(ip).allowed) {
    return NextResponse.json(
      { error: 'rate_limit_exceeded', rate_limit: { remaining: 0, resets_at: null, tier: 'ip' } },
      { status: 429, headers: cors },
    )
  }

  // --- Per-user atomic DB rate limit ---
  let userRemaining: number | null = null
  let resetsAt: string | null = null

  if (user) {
    const { data } = await supabase.rpc('increment_oracle_query', {
      p_user_id: user.id,
      p_limit: USER_LIMIT,
      p_window_ms: WINDOW_MS,
    })

    const row = data?.[0]
    if (!row?.allowed) {
      resetsAt = row?.window_start
        ? new Date(new Date(row.window_start).getTime() + WINDOW_MS).toISOString()
        : null
      return NextResponse.json({
        error: 'rate_limit_exceeded',
        rate_limit: { remaining: 0, resets_at: resetsAt, tier: 'user' },
      }, { status: 429, headers: cors })
    }

    userRemaining = USER_LIMIT - (row?.new_count ?? 0)
    resetsAt = row?.window_start
      ? new Date(new Date(row.window_start).getTime() + WINDOW_MS).toISOString()
      : null
  }

  // --- Concurrent connection limit ---
  if (!acquireConnection(ip)) {
    return NextResponse.json(
      { error: 'too many concurrent connections', rate_limit: { remaining: 0, resets_at: null, tier: 'ip' } },
      { status: 429, headers: cors },
    )
  }

  const rateLimit = user
    ? { remaining: userRemaining, resets_at: resetsAt, tier: 'user' }
    : { remaining: null, resets_at: null, tier: 'anon' }

  // --- Cache check ---
  let key = body.query.trim().toLowerCase()
  if (history.length > 0) {
    const historyHash = createHash('sha256')
      .update(JSON.stringify(history))
      .digest('hex')
      .slice(0, 12)
    key = `${key}:${historyHash}`
  }
  const cached = cacheGet<QueryResponse>(key)

  const sseHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors }

  if (cached) {
    const readable = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const emit = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(sseEvent(event, data)))
        try {
          emit('progress', { stage: 'intent', pct: 10, label: 'Understanding your question…' })
          emit('progress', { stage: 'generating', pct: 55, label: 'Found in cache…' })
          emit('meta', { intent: cached.intent, data: cached.data, rate_limit: rateLimit })
          emit('delta', { text: cached.answer })

          const parsed = parseDecklist(cached.answer)
          if (parsed) {
            const errors = validateDecklist(parsed.main, parsed.side)
            if (errors.length > 0) {
              const copyErrors = errors.filter(e => e.type === 'copy_limit')
              let corrected_list: string | undefined
              if (copyErrors.length > 0) {
                const fixed = fixCopyLimits(parsed.main, parsed.side)
                corrected_list = renderDecklist(fixed.main, fixed.side)
              }
              emit('decklist_warning', { errors, message: formatValidationWarning(errors), corrected_list })
            }
          }

          emit('done', {})
        } finally {
          controller.close()
          releaseConnection(ip)
        }
      },
    })

    return new Response(readable, { headers: sseHeaders })
  }

  // --- Stream query — pipeline runs inside start() so SSE opens immediately ---
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const emit = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(event, data)))

      try {
        const { intent, data, fullAnswer } = await streamPipeline(body.query, history, rateLimit, emit)

        const parsed = parseDecklist(fullAnswer)
        if (parsed) {
          const errors = validateDecklist(parsed.main, parsed.side)
          if (errors.length > 0) {
            const copyErrors = errors.filter(e => e.type === 'copy_limit')
            let corrected_list: string | undefined
            if (copyErrors.length > 0) {
              const fixed = fixCopyLimits(parsed.main, parsed.side)
              corrected_list = renderDecklist(fixed.main, fixed.side)
            }
            emit('decklist_warning', { errors, message: formatValidationWarning(errors), corrected_list })
          }
        }

        emit('done', {})
        cacheSet(key, { answer: fullAnswer, intent, data })
      } catch (err) {
        console.error('[api/query] stream error', err)
        emit('error', { error: 'Stream failed' })
      } finally {
        releaseConnection(ip)
        controller.close()
      }
    },
  })

  return new Response(readable, { headers: sseHeaders })
}
