import { supabase } from '../lib/supabase'
import { llm } from '../lib/llm'

const JACCARD_THRESHOLD = 0.5
const MIN_CLUSTER_SIZE = 2
const DEFAULT_WINDOW_DAYS = 90

interface DeckRecord {
  id: string
  cardSet: Set<string>
}

interface Cluster {
  representative: DeckRecord  // first deck added — used as centroid for similarity
  decks: DeckRecord[]
}

export async function clusterArchetypes(format: string, windowDays = DEFAULT_WINDOW_DAYS): Promise<void> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('decks')
    .select('id, raw_list, tournaments!inner(format, date)')
    .eq('tournaments.format', format)
    .gte('tournaments.date', cutoff)
    .not('placement', 'is', null)
    .lte('placement', 32)

  if (error) throw new Error(`Cluster fetch error: ${error.message}`)
  if (!data || data.length === 0) {
    console.log(`[cluster] No decks found for ${format} in last ${windowDays} days`)
    return
  }

  const decks: DeckRecord[] = data.flatMap(row => {
    const rawList = row.raw_list as { mainboard: { name: string; qty: number }[] } | null
    if (!rawList?.mainboard?.length) return []
    return [{ id: row.id, cardSet: new Set(rawList.mainboard.map(c => c.name)) }]
  })

  console.log(`[cluster] ${format}: clustering ${decks.length} decks`)

  // Greedy Jaccard clustering — O(n*k) where k = number of clusters
  const clusters: Cluster[] = []
  for (const deck of decks) {
    let bestCluster: Cluster | null = null
    let bestScore = 0

    for (const cluster of clusters) {
      const score = jaccard(deck.cardSet, cluster.representative.cardSet)
      if (score > bestScore) {
        bestScore = score
        bestCluster = cluster
      }
    }

    if (bestCluster && bestScore >= JACCARD_THRESHOLD) {
      bestCluster.decks.push(deck)
    } else {
      clusters.push({ representative: deck, decks: [deck] })
    }
  }

  console.log(`[cluster] ${format}: ${clusters.length} clusters (${clusters.filter(c => c.decks.length >= MIN_CLUSTER_SIZE).length} large enough to label)`)

  // Clear stale jaccard assignments for decks in this window before writing fresh ones
  const deckIds = decks.map(d => d.id)
  await supabase
    .from('deck_archetypes')
    .delete()
    .in('deck_id', deckIds)
    .eq('method', 'jaccard')

  for (const cluster of clusters) {
    if (cluster.decks.length < MIN_CLUSTER_SIZE) continue

    const archetypeId = await labelAndUpsertArchetype(cluster, format)
    if (!archetypeId) continue

    const rows = cluster.decks.map(d => ({
      deck_id: d.id,
      archetype_id: archetypeId,
      confidence: parseFloat(avgJaccard(d, cluster).toFixed(4)),
      method: 'jaccard',
    }))

    const { error: upsertErr } = await supabase
      .from('deck_archetypes')
      .upsert(rows, { onConflict: 'deck_id,archetype_id' })

    if (upsertErr) console.error(`[cluster] deck_archetypes upsert error: ${upsertErr.message}`)
  }

  console.log(`[cluster] ${format}: done`)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0
  for (const card of a) if (b.has(card)) intersection++
  return intersection / (a.size + b.size - intersection)
}

function avgJaccard(deck: DeckRecord, cluster: Cluster): number {
  const others = cluster.decks.filter(d => d.id !== deck.id)
  if (others.length === 0) return 1
  const sum = others.reduce((acc, d) => acc + jaccard(deck.cardSet, d.cardSet), 0)
  return sum / others.length
}

function clusterCardFrequency(cluster: Cluster): { name: string; freq: number }[] {
  const counts = new Map<string, number>()
  for (const deck of cluster.decks) {
    for (const card of deck.cardSet) {
      counts.set(card, (counts.get(card) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, freq: count / cluster.decks.length }))
    .sort((a, b) => b.freq - a.freq)
    .slice(0, 15)
}

async function labelAndUpsertArchetype(cluster: Cluster, format: string): Promise<string | null> {
  const topCards = clusterCardFrequency(cluster)
  const cardList = topCards.map(c => `${c.name} (${Math.round(c.freq * 100)}%)`).join(', ')

  const raw = await llm.complete(
    `You are labeling Magic: the Gathering archetypes. Given the most common mainboard cards from a cluster of ${format} decks, return ONLY the canonical archetype name — nothing else. Examples: "Izzet Murktide", "Mono-Red Burn", "Amulet Titan", "Eldrazi Ramp". No explanation, no punctuation, no quotes.`,
    `${format} cluster. Top mainboard cards: ${cardList}`,
    { maxTokens: 32, temperature: 0 },
  )

  const name = raw.trim().replace(/^["']|["']$/g, '')
  if (!name) return null

  const id = slugify(name) + '-' + format
  const keyCards = topCards.filter(c => c.freq >= 0.6).map(c => c.name)

  // Don't overwrite admin-managed archetypes' names
  const { data: existing } = await supabase
    .from('archetypes')
    .select('is_overridden')
    .eq('id', id)
    .maybeSingle()

  if (existing?.is_overridden) {
    // Archetype exists and is admin-managed — only update key_cards if empty
    const { error } = await supabase
      .from('archetypes')
      .update({ key_cards: keyCards, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('is_overridden', false)  // no-op if overridden
    if (error) console.error(`[cluster] archetype update error: ${error.message}`)
  } else {
    const { error } = await supabase
      .from('archetypes')
      .upsert({
        id,
        name,
        format,
        key_cards: keyCards,
        is_overridden: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })
    if (error) {
      console.error(`[cluster] archetype upsert error: ${error.message}`)
      return null
    }
  }

  console.log(`[cluster] ${format}: "${name}" — ${cluster.decks.length} decks, key cards: ${keyCards.slice(0, 5).join(', ')}`)
  return id
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
