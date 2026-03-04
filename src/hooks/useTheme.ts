'use client'

import { useState, useEffect } from 'react'

export const THEMES = ['dark', 'light', 'terminal'] as const
export type Theme = typeof THEMES[number]

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('dark')

  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme') as Theme || 'dark'
    setThemeState(t)
  }, [])

  function setTheme(t: Theme) {
    document.documentElement.setAttribute('data-theme', t)
    localStorage.setItem('fm_theme', t)
    setThemeState(t)
  }

  return { theme, setTheme, themes: THEMES }
}
