import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { extractEventData } from '../scrapers/mtgo.js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function main() {
  const { data: jobs } = await supabase
    .from('scrape_jobs')
    .select('id, source_url, raw_content')
    .eq('source', 'mtgo')
    .eq('status', 'parsed')
    .limit(2)

  for (const job of jobs ?? []) {
    console.log(`\n=== ${job.source_url?.split('/').pop()} ===`)
    const data = extractEventData(job.raw_content)
    if (!data) continue

    const deck = data.decklists[0] as unknown as Record<string, unknown>
    const sideboardDeck = deck['sideboard_deck'] as { qty: string; card_attributes: { card_name: string } }[] | null
    console.log(`  sideboard_deck length: ${sideboardDeck?.length ?? 'undefined/null'}`)
    if (sideboardDeck?.length) {
      console.log('  First 5 sideboard_deck entries:')
      for (const c of sideboardDeck.slice(0, 5)) {
        console.log(`    ${JSON.stringify(c)}`)
      }
      // Card count
      const total = sideboardDeck.reduce((s, c) => s + parseInt(c.qty, 10), 0)
      console.log(`  Total sideboard card quantity: ${total}`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
