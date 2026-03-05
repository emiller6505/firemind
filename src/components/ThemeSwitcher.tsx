'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme, THEMES, type Theme } from '@/hooks/useTheme'

const THEME_LABELS: Record<Theme, string> = {
  dark: 'Izzet Dark',
  light: 'Blueprint',
  terminal: 'Terminal',
  arcana: 'Arcana',
}

const THEME_SWATCHES: Record<Theme, string[]> = {
  dark: ['#08070E', '#0E101E', '#191E32', '#4F8EF7', '#D4552A'],
  light: ['#EFF2F8', '#FFFFFF', '#CDD4E8', '#2563EB', '#0F172A'],
  terminal: ['#0A0F0A', '#0F160F', '#1A2E1A', '#22C55E', '#DCFCE7'],
  arcana: ['#F4E8C9', '#EBDCB9', '#B49B6E', '#7C3AED', '#1C140C'],
}

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return

    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, close])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-8 h-8 flex items-center justify-center rounded-md text-ash hover:text-ink hover:bg-surface transition-colors"
        aria-label="Switch theme"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M8 1a7 7 0 0 1 0 14V1Z"
            fill="currentColor"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-[180px] rounded-md border border-edge bg-surface shadow-lg py-1 z-50">
          {THEMES.map(t => {
            const active = t === theme
            return (
              <button
                key={t}
                onClick={() => { setTheme(t); close() }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  active ? 'text-ink' : 'text-ash hover:text-ink hover:bg-surface'
                }`}
              >
                <span className="w-4 text-center text-xs">
                  {active ? '✓' : ''}
                </span>
                <span className="flex-1 text-left">{THEME_LABELS[t]}</span>
                <span className="inline-flex gap-1">
                  {THEME_SWATCHES[t].map((color, i) => (
                    <span
                      key={i}
                      className="w-2 h-2 rounded-full border border-edge/30"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
