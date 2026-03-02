/**
 * Diagnostic script — hit the Topdeck API and dump a sample response.
 * Run: npx tsx src/scripts/test-topdeck.ts
 */
import 'dotenv/config'

const API_KEY = process.env.TOPDECK_API_KEY
if (!API_KEY) throw new Error('TOPDECK_API_KEY not set')

const BASE_URL = 'https://topdeck.gg/api'

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

async function main() {
  // Probe different game name variants
  const gameNames = ['MtG', 'Magic', 'MTG', 'magic-the-gathering', 'Magic: The Gathering']
  for (const game of gameNames) {
    const data = await post('/v2/tournaments', { game, format: 'Modern', last: 7 }) as unknown[]
    const results = Array.isArray(data) ? data : [data]
    console.log(`game="${game}" → ${results.length} results`)
    if (results.length > 0) {
      console.log('  Sample keys:', Object.keys(results[0] as object).join(', '))
      break
    }
  }

  // Check what standing fields look like with players+record columns
  console.log('\nChecking standing field shapes with players+record columns...\n')
  const modernData = await post('/v2/tournaments', {
    game: 'Magic: The Gathering',
    format: 'Modern',
    last: 90,
    columns: ['decklist', 'players', 'record'],
  })

  const tournaments = Array.isArray(modernData) ? modernData : [modernData]
  console.log(`Found ${tournaments.length} tournaments\n`)

  if (tournaments.length === 0) {
    // Try without player count filter to see if there's any data at all
    console.log('No results — trying without participantMin filter...\n')
    const allData = await post('/v2/tournaments', {
      game: 'MtG',
      format: 'Modern',
      last: 30,
    }) as unknown[]
    const all = Array.isArray(allData) ? allData : [allData]
    console.log(`Found ${all.length} tournaments without filter`)
    if (all.length > 0) {
      console.log('\nSample tournament (first result):')
      console.log(JSON.stringify(all[0], null, 2))
    }
    return
  }

  // Find an event that has decklists and show its full standing structure
  const withDecks = tournaments.filter(t =>
    ((t as Record<string,unknown>)['standings'] as unknown[]).some(s => (s as Record<string,unknown>)['decklist'] !== null)
  )
  console.log(`Events with at least one decklist: ${withDecks.length}`)

  if (withDecks.length > 0) {
    const t = withDecks[0] as Record<string, unknown>
    const standings = t['standings'] as unknown[]
    const withDecklist = standings.find(s => (s as Record<string,unknown>)['decklist'] !== null) as Record<string,unknown>
    console.log(`\nEvent: ${t['tournamentName']} (${standings.length} players)`)
    console.log('Standing keys:', Object.keys(withDecklist).join(', '))
    // Truncate decklist text for readability but show deckObj shape
    const display = { ...withDecklist }
    if (typeof display['decklist'] === 'string') {
      display['decklist'] = display['decklist'].slice(0, 100) + '...'
    }
    if (display['deckObj']) {
      const obj = display['deckObj'] as Record<string,unknown>
      // Show just first card of each section
      const truncated: Record<string,unknown> = {}
      for (const [section, cards] of Object.entries(obj)) {
        if (typeof cards === 'object' && cards !== null && !Array.isArray(cards)) {
          const entries = Object.entries(cards as Record<string,unknown>)
          truncated[section] = entries.length > 0 ? { [entries[0][0]]: entries[0][1], '...': `${entries.length} total cards` } : cards
        } else {
          truncated[section] = cards
        }
      }
      display['deckObj'] = truncated
    }
    console.log(JSON.stringify(display, null, 2))
  }

  // Dump one full tournament raw for schema inspection
  if (tournaments.length > 0) {
    console.log('\n=== RAW FIRST TOURNAMENT (truncated standings) ===')
    const sample = { ...(tournaments[0] as Record<string, unknown>) }
    // Truncate standings to first 2 entries for readability
    const standingsKey = Object.keys(sample).find(k => Array.isArray(sample[k]) && (sample[k] as unknown[]).length > 2)
    if (standingsKey) {
      sample[standingsKey] = (sample[standingsKey] as unknown[]).slice(0, 2)
      sample['_note'] = `standings truncated to 2 of ${(tournaments[0] as Record<string, unknown>)[standingsKey] ? ((tournaments[0] as Record<string, unknown>)[standingsKey] as unknown[]).length : '?'}`
    }
    console.log(JSON.stringify(sample, null, 2))
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
