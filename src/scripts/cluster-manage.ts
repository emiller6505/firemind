/**
 * cluster-manage — manual cluster override and rerun tool
 *
 * Usage:
 *   npm run cluster:manage -- list [--format modern|standard]
 *   npm run cluster:manage -- override --from "Boros Nacatl Aggro" --to "Boros Energy" --format modern
 *   npm run cluster:manage -- unpin --name "Boros Energy" --format modern
 *   npm run cluster:manage -- rerun [--format modern|standard]
 */

import 'dotenv/config'
import { supabase } from '../lib/supabase.js'
import { clusterArchetypes } from '../workers/cluster.js'

const FORMATS = ['modern', 'standard'] as const
type Format = typeof FORMATS[number]

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const cmd = args[0]

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`)
  return i !== -1 ? args[i + 1] ?? null : null
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function list(format?: string) {
  let query = supabase
    .from('archetypes')
    .select('id, name, format, is_overridden, key_cards, updated_at')
    .order('format')
    .order('name')

  if (format) query = query.eq('format', format)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  if (!data?.length) { console.log('No archetypes found.'); return }

  for (const a of data) {
    const pin = a.is_overridden ? ' [pinned]' : ''
    const cards = (a.key_cards ?? []).slice(0, 3).join(', ')
    console.log(`  ${a.format.padEnd(8)} ${a.name}${pin}`)
    if (cards) console.log(`           key cards: ${cards}`)
  }
  console.log(`\n${data.length} archetype(s)`)
}

// ---------------------------------------------------------------------------
// override — rename + pin so future cluster runs don't overwrite
// ---------------------------------------------------------------------------

async function override(fromName: string, toName: string, format: Format) {
  const oldId = slugify(fromName) + '-' + format
  const newId = slugify(toName) + '-' + format

  // 1. Find old archetype
  const { data: old, error: findErr } = await supabase
    .from('archetypes')
    .select('*')
    .eq('id', oldId)
    .maybeSingle()

  if (findErr) throw new Error(findErr.message)
  if (!old) {
    // Try searching by name directly — slug might not match exactly
    const { data: byName, error: nameErr } = await supabase
      .from('archetypes')
      .select('*')
      .ilike('name', fromName)
      .eq('format', format)
      .maybeSingle()
    if (nameErr) throw new Error(nameErr.message)
    if (!byName) {
      console.error(`Archetype not found: "${fromName}" (${format})`)
      console.log('Run "list" to see current archetypes.')
      process.exit(1)
    }
    // Recurse with correct ID
    return overrideById(byName.id, byName, toName, newId)
  }

  return overrideById(oldId, old, toName, newId)
}

async function overrideById(
  oldId: string,
  old: Record<string, unknown>,
  toName: string,
  newId: string,
) {
  if (oldId === newId) {
    // Same slug — just update the name and pin in place
    const { error } = await supabase
      .from('archetypes')
      .update({ name: toName, is_overridden: true, updated_at: new Date().toISOString() })
      .eq('id', oldId)
    if (error) throw new Error(error.message)
    console.log(`Pinned "${old.name}" → "${toName}" (ID unchanged: ${oldId})`)
    return
  }

  // Different slug — proper rename: create new archetype, migrate assignments, delete old

  // 2. Upsert new archetype
  const { error: upsertErr } = await supabase
    .from('archetypes')
    .upsert({
      id:           newId,
      name:         toName,
      format:       old.format,
      key_cards:    old.key_cards,
      description:  old.description,
      is_overridden: true,
      updated_at:   new Date().toISOString(),
    }, { onConflict: 'id' })
  if (upsertErr) throw new Error(`Archetype upsert: ${upsertErr.message}`)

  // 3. Fetch existing deck_archetypes assignments for old archetype
  const { data: assignments, error: fetchErr } = await supabase
    .from('deck_archetypes')
    .select('deck_id, confidence, method')
    .eq('archetype_id', oldId)
  if (fetchErr) throw new Error(`Fetch assignments: ${fetchErr.message}`)

  // 4. Insert them under the new archetype_id
  if (assignments && assignments.length > 0) {
    const rows = assignments.map(a => ({
      deck_id:      a.deck_id,
      archetype_id: newId,
      confidence:   a.confidence,
      method:       a.method,
    }))
    const { error: insertErr } = await supabase
      .from('deck_archetypes')
      .upsert(rows, { onConflict: 'deck_id,archetype_id' })
    if (insertErr) throw new Error(`Migrate assignments: ${insertErr.message}`)
  }

  // 5. Delete old deck_archetypes rows
  await supabase.from('deck_archetypes').delete().eq('archetype_id', oldId)

  // 6. Delete old archetype (cascades snapshots)
  const { error: delErr } = await supabase.from('archetypes').delete().eq('id', oldId)
  if (delErr) throw new Error(`Delete old archetype: ${delErr.message}`)

  console.log(`Renamed "${old.name}" → "${toName}"`)
  console.log(`  old ID: ${oldId}`)
  console.log(`  new ID: ${newId}`)
  console.log(`  assignments migrated: ${assignments?.length ?? 0}`)
  console.log(`  pinned: true (cluster runs will not rename this archetype)`)
}

// ---------------------------------------------------------------------------
// unpin — allow future cluster runs to rename this archetype
// ---------------------------------------------------------------------------

async function unpin(name: string, format: Format) {
  const { data, error } = await supabase
    .from('archetypes')
    .update({ is_overridden: false, updated_at: new Date().toISOString() })
    .ilike('name', name)
    .eq('format', format)
    .select('id, name')

  if (error) throw new Error(error.message)
  if (!data?.length) {
    console.error(`Archetype not found: "${name}" (${format})`)
    process.exit(1)
  }
  console.log(`Unpinned "${data[0].name}" — cluster runs may rename this archetype`)
}

// ---------------------------------------------------------------------------
// rerun
// ---------------------------------------------------------------------------

async function rerun(format?: string) {
  const targets = format ? [format as Format] : [...FORMATS]
  for (const f of targets) {
    console.log(`\nRerunning cluster for ${f}...`)
    await clusterArchetypes(f)
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

switch (cmd) {
  case 'list':
    await list(flag('format') ?? undefined)
    break

  case 'override': {
    const from = flag('from')
    const to   = flag('to')
    const fmt  = flag('format') as Format | null
    if (!from || !to || !fmt) {
      console.error('Usage: cluster:manage -- override --from "<name>" --to "<name>" --format modern|standard')
      process.exit(1)
    }
    if (!FORMATS.includes(fmt)) {
      console.error(`Invalid format "${fmt}". Must be: ${FORMATS.join(', ')}`)
      process.exit(1)
    }
    await override(from, to, fmt)
    break
  }

  case 'unpin': {
    const name = flag('name')
    const fmt  = flag('format') as Format | null
    if (!name || !fmt) {
      console.error('Usage: cluster:manage -- unpin --name "<name>" --format modern|standard')
      process.exit(1)
    }
    if (!FORMATS.includes(fmt)) {
      console.error(`Invalid format "${fmt}". Must be: ${FORMATS.join(', ')}`)
      process.exit(1)
    }
    await unpin(name, fmt)
    break
  }

  case 'rerun':
    await rerun(flag('format') ?? undefined)
    break

  default:
    console.log(`cluster-manage — manual archetype override and cluster rerun

Commands:
  list      [--format modern|standard]
  override  --from "<name>" --to "<name>" --format modern|standard
  unpin     --name "<name>" --format modern|standard
  rerun     [--format modern|standard]

Examples:
  npm run cluster:manage -- list
  npm run cluster:manage -- list --format modern
  npm run cluster:manage -- override --from "Boros Nacatl Aggro" --to "Boros Energy" --format modern
  npm run cluster:manage -- unpin --name "Boros Energy" --format modern
  npm run cluster:manage -- rerun --format modern`)
}
