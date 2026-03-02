/**
 * Scrape worker — orchestrates all scrapers.
 * Run: npx tsx src/workers/scrape.ts
 * Scheduled: every 12h via Render cron
 */
import 'dotenv/config'
import { scrapeNewMtgoEvents } from '../scrapers/mtgo.js'
import { parsePendingMtgoJobs } from '../parsers/mtgo.js'
import { scrapeNewMtggoldfishEvents } from '../scrapers/mtggoldfish.js'
import { parsePendingMtggoldfishJobs } from '../parsers/mtggoldfish.js'
import { scrapeNewMtgtop8Events } from '../scrapers/mtgtop8.js'
import { parsePendingMtgtop8Jobs } from '../parsers/mtgtop8.js'
import { scrapeNewTopdeckEvents } from '../scrapers/topdeck.js'
import { parsePendingTopdeckJobs } from '../parsers/topdeck.js'

async function main() {
  console.log(`[scrape] Starting scrape run at ${new Date().toISOString()}`)

  await scrapeNewMtgoEvents()
  await parsePendingMtgoJobs()

  await scrapeNewMtggoldfishEvents()
  await parsePendingMtggoldfishJobs()

  await scrapeNewMtgtop8Events()
  await parsePendingMtgtop8Jobs()

  await scrapeNewTopdeckEvents()
  await parsePendingTopdeckJobs()

  console.log(`[scrape] Scrape run complete at ${new Date().toISOString()}`)
}

main().catch(err => {
  console.error('[scrape] Fatal error:', err)
  process.exit(1)
})
