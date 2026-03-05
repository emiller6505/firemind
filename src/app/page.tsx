import Link from 'next/link'
import { buttonVariants } from '@/components/ui'
import { createClient } from '@/lib/supabase-server'
import OracleInput from '@/components/landing/OracleInput'

type SnapshotRow = {
  id: number
  archetype_id: string
  meta_share: number
  trend_delta: number | null
  archetypes: { name: string }
}

function trendArrow(delta: number | null): { label: string; color: string } | null {
  if (delta === null || delta === undefined) return null
  if (delta > 3) return { label: '↑↑', color: 'text-spark' }
  if (delta > 0) return { label: '↑', color: 'text-spark' }
  if (delta === 0) return { label: '→', color: 'text-ash' }
  if (delta > -3) return { label: '↓', color: 'text-flame' }
  return { label: '↓↓', color: 'text-flame' }
}

function MetaBar({ name, href, share, trendDelta, maxShare }: { name: string; href: string; share: number; trendDelta: number | null; maxShare: number }) {
  const trend = trendArrow(trendDelta)
  return (
    <div className="flex items-center gap-2 sm:gap-3 py-1.5">
      <div className="flex-1 min-w-0 bg-edge rounded-full h-1.5">
        <div
          className="bg-flame/60 h-1.5 rounded-full"
          style={{ width: `${(share / (maxShare * 2)) * 100}%` }}
        />
      </div>
      <Link href={href} className="text-sm text-ink/80 hover:text-spark transition-colors shrink-0 truncate max-w-[10ch] sm:max-w-[16ch]">{name}</Link>
      <span className="text-xs text-ash tabular-nums shrink-0">{share}%</span>
      {trend && <span className={`text-xs font-medium shrink-0 ${trend.color}`}>{trend.label}</span>}
    </div>
  )
}

async function fetchTopArchetypes(format: string): Promise<SnapshotRow[]> {
  const supabase = await createClient()

  // Find the latest window_end, then pick the 30d window (latest window_start for that end date)
  const { data: latest } = await supabase
    .from('metagame_snapshots')
    .select('window_start, window_end')
    .eq('format', format)
    .order('window_end', { ascending: false })
    .order('window_start', { ascending: false })
    .limit(1)
    .single()

  if (!latest) return []

  const { data } = await supabase
    .from('metagame_snapshots')
    .select('id, archetype_id, meta_share, trend_delta, archetypes(name)')
    .eq('format', format)
    .eq('window_start', latest.window_start)
    .eq('window_end', latest.window_end)
    .order('meta_share', { ascending: false })
    .limit(4)
    .returns<SnapshotRow[]>()

  return data ?? []
}

function FormatColumn({ label, href, format, rows }: { label: string; href: string; format: string; rows: SnapshotRow[] }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-ash uppercase tracking-widest">{label}</h2>
        <Link href={href} className="text-xs text-spark hover:text-spark/80 transition-colors">
          Full breakdown →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ash/60 italic py-4">No data yet</p>
      ) : (
        rows.map(r => (
          <MetaBar
            key={r.id}
            name={r.archetypes.name}
            href={`/data/${format}/${r.archetype_id}`}
            share={Number(r.meta_share)}
            trendDelta={r.trend_delta !== null ? Number(r.trend_delta) : null}
            maxShare={Number(rows[0].meta_share)}
          />
        ))
      )}
    </div>
  )
}

export default async function LandingPage() {
  const [modernMeta, standardMeta] = await Promise.all([
    fetchTopArchetypes('modern'),
    fetchTopArchetypes('standard'),
  ])

  return (
    <main className="max-w-4xl mx-auto px-6 py-10 md:py-16 space-y-10 md:space-y-16">

      {/* Hero */}
      <div className="space-y-8">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-ink">
            Know what&apos;s winning.<br />
            <span className="text-ink/70 font-normal">Before you register.</span>
          </h1>
        </div>

        <OracleInput />
      </div>

      {/* Divider */}
      <div className="border-t border-edge" />

      {/* Live meta snapshot */}
      <div className="bg-surface border border-edge rounded-xl p-5 md:p-8 grid grid-cols-1 md:grid-cols-2 gap-10">
        <FormatColumn label="Modern" href="/data/modern" format="modern" rows={modernMeta} />
        <FormatColumn label="Standard" href="/data/standard" format="standard" rows={standardMeta} />
      </div>

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <Link href="/chat" className={buttonVariants()}>
          Ask the Firemind — it&apos;s free
        </Link>
        <Link href="/data" className={buttonVariants({ variant: 'secondary' })}>
          See metagame charts →
        </Link>
      </div>

    </main>
  )
}
