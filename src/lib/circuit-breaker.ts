import type { SupabaseClient } from '@supabase/supabase-js'

export const DAILY_TOTAL_LIMIT = 500
const REFRESH_INTERVAL_MS = 60_000

let cachedTotal = 0
let lastRefresh = 0
let tripped = false

export async function checkCircuitBreaker(supabase: SupabaseClient): Promise<boolean> {
  if (tripped) {
    const now = Date.now()
    if (now - lastRefresh < REFRESH_INTERVAL_MS) return false
    // Re-check in case a new day started
  }

  const now = Date.now()
  if (now - lastRefresh < REFRESH_INTERVAL_MS) return !tripped

  const todayUTC = new Date()
  todayUTC.setUTCHours(0, 0, 0, 0)

  const { count } = await supabase
    .from('oracle_queries')
    .select('*', { count: 'exact', head: true })
    .gte('window_start', todayUTC.toISOString())

  cachedTotal = count ?? 0
  lastRefresh = now
  tripped = cachedTotal >= DAILY_TOTAL_LIMIT

  return !tripped
}

export function _resetForTest(): void {
  cachedTotal = 0
  lastRefresh = 0
  tripped = false
}
