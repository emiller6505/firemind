'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase-browser'
import { Button, Drawer } from '@/components/ui'
import AuthModal from './AuthModal'
import ThemeSwitcher from './ThemeSwitcher'
import { ANON_LIMIT, ANON_STORAGE_KEY, WINDOW_MS } from '@/lib/rate-limit-constants'

export default function Nav() {
  const path = usePathname()
  const [user, setUser] = useState<User | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const avatarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const supabase = createClient()

    supabase.auth.getUser().then(({ data }) => setUser(data.user))

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null)
        if (session?.user) setShowAuth(false)
      },
    )

    return () => subscription.unsubscribe()
  }, [])

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [path])

  const closeAvatar = useCallback(() => setAvatarOpen(false), [])

  useEffect(() => {
    if (!avatarOpen) return

    function handleClick(e: MouseEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        closeAvatar()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeAvatar()
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [avatarOpen, closeAvatar])

  async function signOut() {
    const supabase = createClient()
    // Exhaust anon bucket BEFORE signOut so onAuthStateChange listeners see it.
    // Preserve existing window_start if active, otherwise start a new window.
    let windowStart = new Date().toISOString()
    try {
      const raw = localStorage.getItem(ANON_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed.window_start && Date.now() - new Date(parsed.window_start).getTime() < WINDOW_MS) {
          windowStart = parsed.window_start
        }
      }
    } catch { /* use new window */ }
    localStorage.setItem(ANON_STORAGE_KEY, JSON.stringify({ count: ANON_LIMIT, window_start: windowStart }))
    await supabase.auth.signOut()
    setUser(null)
    setAvatarOpen(false)
  }

  const initials = user?.email?.[0]?.toUpperCase() ?? '?'

  return (
    <>
      <nav className="sticky top-0 z-50 border-b border-edge bg-canvas/90 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 h-12 flex items-center gap-6">

          <Link href="/" className="flex items-center gap-1.5 shrink-0 group">
            <span className="text-flame text-base leading-none">⚡</span>
            <span className="font-semibold tracking-tight text-ink group-hover:text-spark transition-colors">
              Firemind
            </span>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-1">
            <NavLink href="/chat" active={path.startsWith('/chat')}>Chat</NavLink>
            <NavLink href="/data" active={path.startsWith('/data')}>Metagame Data</NavLink>
          </div>

          {/* Desktop right side */}
          <div className="hidden md:flex ml-auto items-center gap-2">
            <ThemeSwitcher />
            {user ? (
              <>
                <IconButton
                  label="History"
                  onClick={() => setHistoryOpen(true)}
                >
                  🕐
                </IconButton>
                <IconButton
                  label="Alerts"
                  onClick={() => setAlertsOpen(true)}
                >
                  🔔
                </IconButton>
                <div ref={avatarRef} className="relative">
                  <button
                    onClick={() => setAvatarOpen(o => !o)}
                    className="w-8 h-8 rounded-full bg-edge text-ink text-sm font-medium flex items-center justify-center hover:bg-ash/20 transition-colors"
                    aria-label="Account menu"
                  >
                    {initials}
                  </button>
                  {avatarOpen && (
                    <div className="absolute right-0 top-10 w-56 rounded-md border border-edge bg-surface shadow-lg py-1 z-50">
                      <div className="px-3 py-2 text-xs text-ash truncate">
                        {user.email}
                      </div>
                      <div className="border-t border-edge" />
                      <button
                        onClick={signOut}
                        className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-edge transition-colors"
                      >
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setShowAuth(true)}>
                Sign in
              </Button>
            )}
            <button className="text-sm font-medium px-3 py-2 rounded-md border border-flame/20 bg-flame/10 text-flame hover:bg-flame/20 transition-colors">
              Go Spike ↑
            </button>
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileOpen(o => !o)}
            className="md:hidden ml-auto w-10 h-10 flex items-center justify-center rounded-md text-ash hover:text-ink hover:bg-surface transition-colors"
            aria-label="Toggle menu"
          >
            {mobileOpen ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>

        </div>

        {/* Mobile slide-down panel */}
        {mobileOpen && (
          <div className="md:hidden border-t border-edge bg-canvas/95 backdrop-blur-sm px-6 py-4 space-y-1">
            <MobileNavLink href="/chat" active={path.startsWith('/chat')}>Chat</MobileNavLink>
            <MobileNavLink href="/data" active={path.startsWith('/data')}>Metagame Data</MobileNavLink>
            <div className="flex items-center gap-2 py-2">
              <span className="text-sm text-ash">Theme</span>
              <ThemeSwitcher />
            </div>
            <div className="border-t border-edge my-3" />
            {user ? (
              <>
                <button
                  onClick={() => { setHistoryOpen(true); setMobileOpen(false) }}
                  className="block w-full text-left text-sm text-ash hover:text-ink py-2.5 min-h-[44px]"
                >
                  🕐 History
                </button>
                <button
                  onClick={() => { setAlertsOpen(true); setMobileOpen(false) }}
                  className="block w-full text-left text-sm text-ash hover:text-ink py-2.5 min-h-[44px]"
                >
                  🔔 Alerts
                </button>
                <div className="border-t border-edge my-3" />
                <div className="text-xs text-ash truncate py-1">{user.email}</div>
                <button
                  onClick={signOut}
                  className="block w-full text-left text-sm text-ink hover:text-spark py-2.5 min-h-[44px]"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => { setShowAuth(true); setMobileOpen(false) }}
                className="block w-full text-left text-sm text-ink hover:text-spark py-2.5 min-h-[44px]"
              >
                Sign in
              </button>
            )}
            <div className="border-t border-edge my-3" />
            <button className="w-full text-sm font-medium px-3 py-2.5 min-h-[44px] rounded-md border border-flame/20 bg-flame/10 text-flame hover:bg-flame/20 transition-colors text-center">
              Go Spike ↑
            </button>
          </div>
        )}
      </nav>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}

      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="History">
        <p className="text-sm text-ash">Coming in toy.8</p>
      </Drawer>

      <Drawer open={alertsOpen} onClose={() => setAlertsOpen(false)} title="Alerts">
        <p className="text-sm text-ash">Coming soon</p>
      </Drawer>
    </>
  )
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`text-sm px-3 py-1.5 min-h-[44px] flex items-center rounded-md transition-colors ${
        active
          ? 'text-ink bg-edge'
          : 'text-ash hover:text-ink hover:bg-surface'
      }`}
    >
      {children}
    </Link>
  )
}

function MobileNavLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`block text-sm py-2.5 min-h-[44px] transition-colors ${
        active ? 'text-spark' : 'text-ink hover:text-spark'
      }`}
    >
      {children}
    </Link>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="w-8 h-8 flex items-center justify-center rounded-md text-ash hover:text-ink hover:bg-surface transition-colors"
    >
      {children}
    </button>
  )
}
