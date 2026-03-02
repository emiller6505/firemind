'use client'

import { useState, useRef, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const SUGGESTED_PROMPTS = [
  "What's dominating Modern right now?",
  "What should I play at my RCQ this weekend?",
  "Is Murktide still the deck to beat?",
  "Build me a sideboard plan vs Amulet Titan",
]

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
  'VERY HIGH': 'text-emerald-400',
  'HIGH':      'text-spark',
  'MEDIUM':    'text-yellow-400',
  'LOW':       'text-flame',
}

interface Message {
  role: 'user' | 'oracle'
  content: string
  meta?: {
    format: string | null
    window_days: number
    decks_analyzed: number
    confidence?: Confidence
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
        <span className="text-spark text-xs">⚡</span>
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

function ChatPageInner() {
  const searchParams = useSearchParams()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const didAutoSubmit = useRef(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Auto-submit query passed from landing page
  useEffect(() => {
    if (didAutoSubmit.current) return
    const q = searchParams.get('q')
    if (q) {
      didAutoSubmit.current = true
      submit(q)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(query: string) {
    const q = query.trim()
    if (!q || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setLoading(true)

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unknown error')

      setMessages(prev => [...prev, {
        role: 'oracle',
        content: data.answer,
        meta: {
          format: data.intent?.format,
          window_days: data.data?.window_days,
          decks_analyzed: data.data?.top_decks?.length ?? 0,
          confidence: data.data?.confidence,
        },
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'oracle',
        content: `Something went wrong. ${err instanceof Error ? err.message : 'Please try again.'}`,
      }])
    } finally {
      setLoading(false)
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    submit(input)
  }

  return (

    <div className="flex flex-col h-[calc(100vh-3rem)]">

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">

          {messages.length === 0 && (
            <div className="pt-16 space-y-8">
              <div className="text-center space-y-2">
                <p className="text-ash text-sm">Ask about the current metagame, what to play, or how decks and cards perform.</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {SUGGESTED_PROMPTS.map(prompt => (
                  <button
                    key={prompt}
                    onClick={() => submit(prompt)}
                    className="text-left text-sm text-ash hover:text-ink bg-surface hover:bg-edge border border-edge rounded-lg px-4 py-3 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="bg-surface border border-edge text-ink rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%] text-sm">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Oracle label */}
                  <div className="flex items-center gap-2">
                    <span className="text-spark text-xs">⚡</span>
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                        {msg.content}
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
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}

          {loading && <OracleThinking />}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar */}
      <div className="border-t border-edge bg-canvas/80 backdrop-blur-sm flex-shrink-0">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <form onSubmit={handleFormSubmit} className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask the Firemind…"
              disabled={loading}
              className="flex-1 bg-surface border border-edge rounded-xl px-4 py-2.5 text-sm text-ink
                placeholder-ash focus:outline-none focus:border-spark/50 focus:glow-spark-sm
                disabled:opacity-50 transition-all"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="bg-spark hover:bg-spark/90 disabled:opacity-40 disabled:cursor-not-allowed
                text-canvas text-sm font-medium px-5 py-2.5 rounded-xl transition-colors"
            >
              Ask
            </button>
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
