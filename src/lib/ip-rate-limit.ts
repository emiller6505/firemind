export const ANON_IP_LIMIT = 20
const WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_BUCKETS = 50_000

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

function evictExpired(now: number): void {
  for (const [ip, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) {
      buckets.delete(ip)
    }
  }
}

export function checkIpLimit(ip: string): { allowed: boolean } {
  const now = Date.now()

  if (buckets.size >= MAX_BUCKETS) {
    evictExpired(now)
  }

  const bucket = buckets.get(ip)

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now })
    return { allowed: true }
  }

  if (bucket.count >= ANON_IP_LIMIT) {
    return { allowed: false }
  }

  bucket.count++
  return { allowed: true }
}

export function _resetForTest(): void {
  buckets.clear()
}
