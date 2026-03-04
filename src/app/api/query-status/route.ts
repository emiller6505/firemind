import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { USER_LIMIT, WINDOW_MS } from '@/lib/rate-limit-constants'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ remaining: null, resets_at: null })
  }

  const { data: row } = await supabase
    .from('oracle_queries')
    .select('count, window_start')
    .eq('user_id', user.id)
    .single()

  const now = Date.now()
  const windowActive = row?.window_start && now - new Date(row.window_start).getTime() < WINDOW_MS
  const used = windowActive ? row.count : 0
  const resetsAt = windowActive
    ? new Date(new Date(row.window_start).getTime() + WINDOW_MS).toISOString()
    : null

  return NextResponse.json({
    remaining: Math.max(0, USER_LIMIT - used),
    resets_at: resetsAt,
  })
}
