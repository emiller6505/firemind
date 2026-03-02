'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

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
      <pre className="bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-300 font-mono overflow-x-auto whitespace-pre">
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 text-xs text-gray-500 hover:text-gray-300 bg-gray-900 border border-gray-700 rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const mdComponents: Components = {
  code({ className, children, ...props }) {
    // Multiline content = fenced block; single-line = inline code
    if (String(children).trim().includes('\n')) {
      return <CodeBlock>{String(children).replace(/\n$/, '')}</CodeBlock>
    }
    return (
      <code className="text-indigo-300 bg-gray-900 px-1 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    )
  },
}

type Confidence = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY HIGH'

const CONFIDENCE_COLORS: Record<Confidence, string> = {
  'VERY HIGH': 'text-emerald-500',
  'HIGH':      'text-blue-400',
  'MEDIUM':    'text-yellow-500',
  'LOW':       'text-red-400',
}

interface Message {
  role: 'user' | 'oracle'
  content: string
  meta?: { format: string | null; window_days: number; decks_analyzed: number; confidence?: Confidence }
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const query = input.trim()
    if (!query || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: query }])
    setLoading(true)

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
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
        content: `Error: ${err instanceof Error ? err.message : 'Something went wrong'}`,
      }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex-shrink-0">
        <h1 className="text-lg font-semibold tracking-tight">Firemind</h1>
        <p className="text-xs text-gray-500 mt-0.5">MTG metagame oracle · real tournament data</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {messages.length === 0 && (
          <div className="text-center text-gray-600 mt-24 space-y-2">
            <p className="text-sm">Ask about the current metagame, what to play, or how cards perform.</p>
            <p className="text-xs text-gray-700">e.g. "What are the best Modern decks right now?" or "How does Burn match up against Tron?"</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            {msg.role === 'user' ? (
              <div className="bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 max-w-[80%] text-sm">
                {msg.content}
              </div>
            ) : (
              <div className="max-w-full space-y-2">
                <div className="prose prose-invert prose-sm max-w-none
                  prose-headings:font-semibold prose-headings:text-gray-100
                  prose-p:text-gray-300 prose-p:leading-relaxed
                  prose-strong:text-gray-100
                  prose-ul:text-gray-300 prose-ol:text-gray-300
                  prose-li:my-0.5
                  prose-table:text-sm prose-th:text-gray-300 prose-td:text-gray-400
                  prose-code:text-indigo-300 prose-code:bg-gray-900 prose-code:px-1 prose-code:rounded">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{msg.content}</ReactMarkdown>
                </div>
                {msg.meta && (
                  <p className="text-xs text-gray-600">
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

        {loading && (
          <div className="flex justify-start">
            <div className="text-gray-500 text-sm animate-pulse">Thinking…</div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 px-6 py-4 flex-shrink-0">
        <form onSubmit={submit} className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask about the metagame…"
            disabled={loading}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-sm
              placeholder-gray-600 focus:outline-none focus:border-indigo-500 focus:ring-1
              focus:ring-indigo-500 disabled:opacity-50 transition-colors"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed
              text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors"
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  )
}
