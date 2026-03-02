import 'dotenv/config'
import { supabase } from '../lib/supabase.js'

const BASE_URL = 'https://topdeck.gg/api'
const GAME = 'Magic: The Gathering'
const FORMATS = ['Modern', 'Standard']
const RATE_LIMIT_MS = 2000

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function apiKey(): string {
  const key = process.env.TOPDECK_API_KEY
  if (!key) throw new Error('TOPDECK_API_KEY not set')
  return key
}

async function post(path: string, body: unknown): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': apiKey(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function get(path: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Authorization': apiKey() },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    return res.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function getAlreadyScrapedTIDs(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('source_url')
    .eq('source', 'topdeck')
    .not('source_url', 'is', null)
  if (error) throw new Error(`DB error: ${error.message}`)
  return new Set((data ?? []).map(r => r.source_url!))
}

interface TopdeckTournament {
  TID: string
  tournamentName: string
  swissNum: number
  startDate: number
  topCut: number
  eventData?: unknown
  standings?: unknown[]
}

export async function scrapeNewTopdeckEvents(): Promise<void> {
  const alreadyScraped = await getAlreadyScrapedTIDs()

  for (const format of FORMATS) {
    console.log(`[topdeck] Fetching ${format} tournaments (last 90 days)...`)

    let tournaments: TopdeckTournament[]
    try {
      const data = await post('/v2/tournaments', { game: GAME, format, last: 90 })
      tournaments = Array.isArray(data) ? data as TopdeckTournament[] : []
    } catch (err) {
      console.error(`[topdeck] Failed to list ${format} tournaments:`, err)
      continue
    }

    const newTournaments = tournaments.filter(t => !alreadyScraped.has(t.TID))
    console.log(`[topdeck] ${format}: ${tournaments.length} total, ${newTournaments.length} new`)

    let stored = 0, errors = 0

    for (const [i, t] of newTournaments.entries()) {
      try {
        const standings = await get(`/v2/tournaments/${t.TID}/standings`)

        // Store TID as source_url for dedup on future runs
        const { error } = await supabase.from('scrape_jobs').insert({
          source: 'topdeck',
          source_url: t.TID,
          raw_content: JSON.stringify({
            meta: { ...t, standings: undefined, format },
            standings,
          }),
          status: 'pending',
        })
        if (error) throw new Error(`Insert error: ${error.message}`)

        stored++
        console.log(`[topdeck] stored: ${t.tournamentName} (${t.TID})`)
      } catch (err) {
        errors++
        console.error(`[topdeck] error: ${t.TID} —`, err)
      }

      if (i < newTournaments.length - 1) await sleep(RATE_LIMIT_MS)
    }

    console.log(`[topdeck] ${format} done — stored: ${stored}, errors: ${errors}`)
  }
}
