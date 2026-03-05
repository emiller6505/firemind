'use client'

import { useState, useRef, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { User } from '@supabase/supabase-js'
import { Button, Input, Card } from '@/components/ui'
import { createClient } from '@/lib/supabase-browser'
import { ANON_LIMIT, USER_LIMIT, ANON_STORAGE_KEY, CHAT_STORAGE_KEY, WINDOW_MS } from '@/lib/rate-limit-constants'
import { remainingColor, counterReady as isCounterReady, showGoSpikeLink } from '@/lib/chat-helpers'

const SUGGESTED_PROMPTS = [
  "What's dominating Modern right now?",
  "What should I play at my RCQ this weekend?",
  "Which Modern decks are using counterspell?",
  "Build me a sideboard plan vs Amulet Titan",
]

// --- useCountdown hook ---
function useCountdown(resetsAt: string | null): string | null {
  const [display, setDisplay] = useState<string | null>(null)

  useEffect(() => {
    if (!resetsAt) { setDisplay(null); return }

    function tick() {
      const diff = new Date(resetsAt!).getTime() - Date.now()
      if (diff <= 0) { setDisplay('00:00:00'); return }
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      setDisplay(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
      )
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [resetsAt])

  return display
}

// --- Anon localStorage helpers ---
// V0 accepted gaps:
// - Multi-tab race: tabs share localStorage but don't sync state in real time
// - Anon→auth carry-over: anon queries don't count against auth limit (conversion incentive)
// - Anon API bypass: no server-side anon enforcement — deferred to toy.7
function getAnonBucket(): { count: number; window_start: string } | null {
  try {
    const raw = localStorage.getItem(ANON_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { count: number; window_start: string }
    if (!parsed.window_start) return null
    if (Date.now() - new Date(parsed.window_start).getTime() >= WINDOW_MS) return null
    return parsed
  } catch { return null }
}

function getAnonCount(): number {
  return getAnonBucket()?.count ?? 0
}

function setAnonCount(count: number) {
  const windowStart = getAnonBucket()?.window_start ?? new Date().toISOString()
  localStorage.setItem(ANON_STORAGE_KEY, JSON.stringify({ count, window_start: windowStart }))
}

// --- Google SVG (shared with AuthModal) ---
function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [children])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <div className="relative group my-3">
      <pre className="bg-canvas border border-edge rounded-lg px-4 py-3 text-sm text-ink/80 font-mono overflow-x-auto whitespace-pre">
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 text-xs text-ash hover:text-ink bg-surface border border-edge rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const mdComponents: Components = {
  code({ className, children, ...props }) {
    if (String(children).trim().includes('\n')) {
      return <CodeBlock>{String(children).replace(/\n$/, '')}</CodeBlock>
    }
    return (
      <code className="text-spark bg-surface px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    )
  },
}

type Confidence = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY HIGH'

const CONFIDENCE_COLORS: Record<Confidence, string> = {
  'VERY HIGH': 'text-spark',
  'HIGH': 'text-spark',
  'MEDIUM': 'text-gold',
  'LOW': 'text-flame',
}

interface Message {
  role: 'user' | 'oracle'
  content: string
  meta?: {
    format: string | null
    window_days: number
    decks_analyzed: number
    confidence?: Confidence
    remaining?: number | null
    decklist_warning?: string | null
    corrected_list?: string | null
  }
}

const THINKING_QUIPS = [
  'The Firemind is considering',
  'The Firemind is brainstorming',
  'The Firemind is preordaining',
  'The Firemind is pondering',
  'The Firemind is surveilling',
  'The Firemind is scrying',
  'The Firemind is consulting the serum visions',
  'The Firemind is peering through the aether',
  'The Firemind is opting',
]

function OracleThinking() {
  const [quipIdx, setQuipIdx] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setQuipIdx(i => (i + 1) % THINKING_QUIPS.length), 2500)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-flame text-xs">⚡</span>
        <span className="text-xs font-medium text-copper tracking-wide uppercase">Firemind</span>
      </div>
      <div className="oracle-border pl-4 py-3 flex items-center gap-2">
        <span className="text-sm text-ash italic">{THINKING_QUIPS[quipIdx]}</span>
        <span className="flex gap-1 self-end mb-0.5">
          <span className="w-1.5 h-1.5 bg-spark/60 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 bg-spark/60 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 bg-spark/60 rounded-full animate-bounce [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  )
}

function AuthPromptCard({ resetsAt, messages }: { resetsAt: string | null; messages: Message[] }) {
  const countdown = useCountdown(resetsAt)

  async function handleSignIn() {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
    } catch { /* best effort */ }

    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/auth/callback' },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-flame text-xs">⚡</span>
        <span className="text-xs font-medium text-copper tracking-wide uppercase">Firemind</span>
      </div>
      <div
        className="pl-4 py-4 pr-4 bg-surface/40 rounded-r-lg border-l-2"
        style={{ borderImage: 'linear-gradient(to bottom, #B87333, #D4552A) 1' }}
      >
        <p className="text-sm text-ink font-medium mb-1">You have great questions.</p>
        <p className="text-sm text-ink/70 mb-4">Create a free account to keep going. No credit card required.</p>

        <Button
          variant="secondary"
          onClick={handleSignIn}
          className="w-full gap-3 py-3 bg-surface text-ink hover:bg-edge"
        >
          <GoogleIcon />
          Sign in with Google
        </Button>

        {countdown && (
          <p className="text-xs text-ash text-center mt-3">
            or wait &middot; resets in <span className="font-mono tabular-nums">{countdown}</span>
          </p>
        )}
      </div>
    </div>
  )
}

function ChatPageInner() {
  const searchParams = useSearchParams()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [anonCount, setAnonCountState] = useState(0)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [resetsAt, setResetsAt] = useState<string | null>(null)
  const [showAuthCard, setShowAuthCard] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [authReady, setAuthReady] = useState(false)
  const submitRef = useRef<(q: string) => void>(() => { })

  const countdown = useCountdown(resetsAt)

  // Auth state
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user: u } }) => {
      setUser(u)
      setAuthReady(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (!session?.user) {
        // Re-read anon bucket (Nav exhausts it on sign-out)
        const count = getAnonCount()
        setAnonCountState(count)
        if (count >= ANON_LIMIT) setShowAuthCard(true)
      } else {
        // Mid-session sign-in: fetch real query count
        setShowAuthCard(false)
        fetch('/api/query-status')
          .then(r => r.json())
          .then(d => {
            if (d.remaining != null) setRemaining(d.remaining)
            if (d.resets_at) setResetsAt(d.resets_at)
          })
          .catch(() => {})
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  // Fetch real query count for logged-in users
  useEffect(() => {
    if (!authReady || !user) return
    fetch('/api/query-status')
      .then(r => r.json())
      .then(d => {
        if (d.remaining != null) setRemaining(d.remaining)
        if (d.resets_at) setResetsAt(d.resets_at)
      })
      .catch(() => { })
  }, [authReady, user])

  // Restore messages after auth redirect
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY)
      if (saved) {
        setMessages(JSON.parse(saved))
        localStorage.removeItem(CHAT_STORAGE_KEY)
      }
    } catch { /* ignore */ }
  }, [])

  // Init anon count
  useEffect(() => {
    setAnonCountState(getAnonCount())
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, loading, showAuthCard])

  // Auto-submit query passed from landing page
  const initialQuery = searchParams.get('q')
  const [autoSubmitted, setAutoSubmitted] = useState(false)
  useEffect(() => {
    if (autoSubmitted || !initialQuery || !authReady) return
    setAutoSubmitted(true)
    submitRef.current(initialQuery)
  }, [initialQuery, autoSubmitted, authReady])

  const isAnon = !user
  const anonAtLimit = isAnon && anonCount >= ANON_LIMIT
  const userAtLimit = !isAnon && remaining === 0
  const atLimit = anonAtLimit || userAtLimit

  async function submit(query: string) {
    const q = query.trim()
    if (!q || loading || atLimit) return

    // Anon pre-check
    if (isAnon) {
      const current = getAnonCount()
      if (current >= ANON_LIMIT) {
        setAnonCountState(current)
        setShowAuthCard(true)
        return
      }
    }

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setLoading(true)

    const currentMessages = [...messages, { role: 'user' as const, content: q }]
    const history = currentMessages
      .map(m => ({ role: m.role === 'oracle' ? 'assistant' as const : 'user' as const, content: m.content }))
      .slice(-6)

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, messages: history }),
      })

      // Non-SSE error responses
      if (!res.ok) {
        const data = await res.json()
        if (res.status === 429) {
          setRemaining(0)
          setResetsAt(data.rate_limit?.resets_at ?? null)
          setMessages(prev => [...prev, {
            role: 'oracle',
            content: "You've reached today's query limit. Check the timer below for when it resets.",
          }])
          return
        }
        throw new Error(data.error ?? 'Unknown error')
      }

      // SSE stream with character-drip buffer for smooth typewriter effect
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''
      let currentEvent = ''
      let metaPayload: { intent?: Record<string, unknown>; data?: Record<string, unknown>; rate_limit?: Record<string, unknown> } | null = null

      // Character drip: tokens queue up here, a fast interval drains them char-by-char
      let charQueue = ''
      let displayed = ''
      let messageAdded = false
      let streamDone = false
      let decklistWarning: string | null = null
      let correctedList: string | null = null
      const CHARS_PER_TICK = 2
      const TICK_MS = 12

      const drip = setInterval(() => {
        if (charQueue.length === 0) {
          if (streamDone) {
            clearInterval(drip)
            setStreaming(false)
          }
          return
        }
        const batch = charQueue.slice(0, CHARS_PER_TICK)
        charQueue = charQueue.slice(CHARS_PER_TICK)
        displayed += batch
        const snapshot = displayed
        setMessages(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last?.role === 'oracle') {
            updated[updated.length - 1] = { ...last, content: snapshot }
          }
          return updated
        })
      }, TICK_MS)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          sseBuffer += decoder.decode(value, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop()!

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7)
            } else if (line.startsWith('data: ')) {
              const payload = JSON.parse(line.slice(6))

              if (currentEvent === 'meta') {
                metaPayload = payload
                if (payload.rate_limit?.tier === 'user') {
                  setResetsAt(payload.rate_limit.resets_at)
                  if (payload.rate_limit.remaining != null) {
                    setRemaining(payload.rate_limit.remaining)
                  }
                }
              } else if (currentEvent === 'delta') {
                if (!messageAdded) {
                  messageAdded = true
                  setLoading(false)
                  setStreaming(true)
                  setMessages(prev => [...prev, { role: 'oracle', content: '' }])
                }
                charQueue += payload.text
              } else if (currentEvent === 'error') {
                clearInterval(drip)
                setStreaming(false)
                if (!messageAdded) {
                  setMessages(prev => [...prev, { role: 'oracle', content: 'Something went wrong. Please try again.' }])
                } else {
                  setMessages(prev => {
                    const updated = [...prev]
                    const last = updated[updated.length - 1]
                    if (last?.role === 'oracle') {
                      updated[updated.length - 1] = { ...last, content: last.content || 'Something went wrong. Please try again.' }
                    }
                    return updated
                  })
                }
              } else if (currentEvent === 'decklist_warning') {
                decklistWarning = payload.message ?? null
                correctedList = payload.corrected_list ?? null
              } else if (currentEvent === 'done') {
                // Flush remaining chars immediately then attach meta
                displayed += charQueue
                charQueue = ''
                const finalContent = displayed

                // Anon: increment localStorage and compute remaining from newCount directly
                let anonRemaining: number | null = null
                if (isAnon) {
                  const newCount = getAnonCount() + 1
                  setAnonCount(newCount)
                  setAnonCountState(newCount)
                  anonRemaining = ANON_LIMIT - newCount
                  if (newCount >= ANON_LIMIT) {
                    setShowAuthCard(true)
                  }
                }

                const queryRemaining = isAnon
                  ? anonRemaining
                  : metaPayload?.rate_limit?.remaining ?? null

                setMessages(prev => {
                  const updated = [...prev]
                  const last = updated[updated.length - 1]
                  if (last?.role === 'oracle') {
                    updated[updated.length - 1] = {
                      ...last,
                      content: finalContent,
                      ...(metaPayload ? {
                        meta: {
                          format: metaPayload.intent?.format as string | null ?? null,
                          window_days: metaPayload.data?.window_days as number,
                          decks_analyzed: (metaPayload.data?.top_decks as unknown[])?.length ?? 0,
                          confidence: metaPayload.data?.confidence as Confidence | undefined,
                          remaining: queryRemaining as number | null,
                          decklist_warning: decklistWarning,
                          corrected_list: correctedList,
                        },
                      } : {}),
                    }
                  }
                  return updated
                })

                streamDone = true
              }
            }
          }
        }
      } finally {
        // If stream ends without a done event, clean up
        if (!streamDone) {
          clearInterval(drip)
          setStreaming(false)
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'oracle',
        content: `Something went wrong. ${err instanceof Error ? err.message : 'Please try again.'}`,
      }])
    } finally {
      setLoading(false)
    }
  }

  submitRef.current = submit

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    submit(input)
  }

  // Compute counter display
  const limit = isAnon ? ANON_LIMIT : USER_LIMIT
  const counterReady = isCounterReady(isAnon, anonCount, remaining)
  const used = isAnon ? anonCount : (remaining != null ? limit - remaining : 0)
  const displayRemaining = limit - used

  // Placeholder for disabled input
  let placeholder = 'Ask the Firemind…'
  if (anonAtLimit) placeholder = 'Sign in to keep going…'
  else if (userAtLimit) placeholder = 'Limit reached'

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">

          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[calc(100vh-10rem)]">
              {atLimit ? (
                <div className="space-y-4 text-center max-w-sm">
                  <div className="text-3xl text-flame/30">⚡</div>
                  <p className="text-sm text-ink font-medium">
                    {anonAtLimit ? "You've used your free queries." : "You've reached today's query limit."}
                  </p>
                  {anonAtLimit ? (
                    <p className="text-sm text-ash">Sign in to get more — it&apos;s free.</p>
                  ) : countdown ? (
                    <p className="text-sm text-ash">
                      Resets in <span className="font-mono tabular-nums">{countdown}</span>
                    </p>
                  ) : (
                    <p className="text-sm text-ash">Your queries will reset soon.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-8 w-full max-w-lg">
                  <div className="text-center space-y-2">
                    <p className="text-ink/75 text-sm">Ask about the current metagame, what to play, or how decks and cards perform.</p>
                  </div>
                  <div
                    className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-16 -my-16 px-12 -mx-12"
                    style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(79,142,247,0.10) 0%, transparent 70%)' }}
                  >
                    {SUGGESTED_PROMPTS.map(prompt => (
                      <Button
                        key={prompt}
                        variant="secondary"
                        onClick={() => submit(prompt)}
                        className="justify-start text-left text-ink/80 bg-surface hover:bg-edge px-4 py-3.5 hover:glow-spark-sm"
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === 'user' ? (
                <div className="flex justify-end">
                  <Card className="rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%] text-sm text-ink">
                    {msg.content}
                  </Card>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Oracle label */}
                  <div className="flex items-center gap-2">
                    <span className="text-flame text-xs">⚡</span>
                    <span className="text-xs font-medium text-copper tracking-wide uppercase">Firemind</span>
                  </div>
                  {/* Response body */}
                  <div className="oracle-border pl-4 bg-surface/40 rounded-r-lg py-3 pr-4">
                    <div className="prose prose-invert prose-sm max-w-none
                      prose-headings:font-semibold prose-headings:text-ink
                      prose-p:text-ink/80 prose-p:leading-relaxed
                      prose-strong:text-ink
                      prose-ul:text-ink/80 prose-ol:text-ink/80
                      prose-li:my-0.5
                      prose-table:text-sm prose-th:text-ink/70 prose-td:text-ink/60
                      prose-code:text-spark prose-code:bg-surface prose-code:px-1 prose-code:rounded">
                      <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} components={mdComponents}>
                        {streaming && i === messages.length - 1 ? msg.content + '▌' : msg.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                  {/* Meta footer */}
                  {msg.meta && (
                    <p className="text-xs text-ash pl-4">
                      {[
                        msg.meta.format,
                        msg.meta.window_days && `last ${msg.meta.window_days}d`,
                        msg.meta.decks_analyzed && `${msg.meta.decks_analyzed} decks`,
                      ].filter(Boolean).join(' · ')}
                      {msg.meta.confidence && (
                        <span className={`ml-2 font-medium ${CONFIDENCE_COLORS[msg.meta.confidence]}`}>
                          {msg.meta.confidence}
                        </span>
                      )}
                      {msg.meta.remaining != null && (
                        <span className={`ml-2 ${remainingColor(msg.meta.remaining)}`}>
                          {msg.meta.remaining} remaining
                        </span>
                      )}
                    </p>
                  )}
                  {msg.meta?.decklist_warning && (
                    <div className="mt-3 pl-4">
                      <div className="text-xs text-flame flex items-start gap-2 whitespace-pre-line">
                        <span>⚠</span>
                        <span>{msg.meta.decklist_warning}</span>
                      </div>
                      {msg.meta.corrected_list && (
                        <div className="mt-2">
                          <p className="text-xs text-ash mb-1">Auto-corrected decklist:</p>
                          <CodeBlock>{msg.meta.corrected_list}</CodeBlock>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {loading && <OracleThinking />}

          {showAuthCard && !loading && <AuthPromptCard resetsAt={resetsAt} messages={messages} />}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="border-t border-edge bg-canvas/80 backdrop-blur-sm flex-shrink-0">
        <div className="max-w-3xl mx-auto px-4 py-3 sm:px-6 sm:py-4 space-y-2">
          {!atLimit && counterReady && (
            <p className={`text-xs ${remainingColor(displayRemaining)} text-center`}>
              {displayRemaining} {displayRemaining === 1 ? 'query' : 'queries'} left{countdown ? <>, resets in <span className="font-mono tabular-nums">{countdown}</span></> : ' today'}.{showGoSpikeLink(displayRemaining) && <>{' '}<a href="/pricing" className="text-spark hover:text-spark/80 transition-colors">Go Spike &rarr;</a></>}
            </p>
          )}
          {atLimit && countdown && (
            <p className="text-xs text-ash text-center font-mono tabular-nums">
              Resets in {countdown}
            </p>
          )}
          <form onSubmit={handleFormSubmit} className="flex gap-3">
            <Input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={placeholder}
              disabled={loading || atLimit}
              className="flex-1"
            />
            <Button disabled={loading || !input.trim() || atLimit}>
              Ask
            </Button>
          </form>
        </div>
      </div>

    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatPageInner />
    </Suspense>
  )
}
