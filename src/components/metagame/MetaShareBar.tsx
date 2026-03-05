'use client'

import { useState } from 'react'
import Link from 'next/link'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import type { MetaShareEntry } from '@/app/data/[format]/queries'

const TIER_COLORS: Record<string, string> = {
  S: '#4F8EF7',
  A: '#C9A050',
  B: '#B87333',
  C: '#4A5878',
}

function TierBadge({ tier }: { tier: string | null }) {
  if (!tier) return null
  const color = TIER_COLORS[tier] ?? '#4A5878'
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold mr-1.5"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {tier}
    </span>
  )
}

function CustomYTick({ x, y, payload, format }: { x: number; y: number; payload: { value: string }; format: string }) {
  const entry = payload.value
  const [tier, archetypeId, name] = entry.split('|')

  return (
    <g transform={`translate(${x},${y})`}>
      <foreignObject x={-200} y={-10} width={200} height={20}>
        <div className="flex items-center justify-end text-xs text-ink truncate">
          <TierBadge tier={tier || null} />
          <Link href={`/data/${format}/${archetypeId}`} className="hover:text-spark truncate">
            {name}
          </Link>
        </div>
      </foreignObject>
    </g>
  )
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ value: number; payload: { label: string } }> }) {
  if (!active || !payload?.[0]) return null
  const { value, payload: item } = payload[0]
  const name = item.label
  return (
    <div className="bg-surface border border-edge rounded-lg px-3 py-2 text-xs">
      <span className="text-ink font-medium">{name}</span>
      <span className="text-ash ml-2">{value.toFixed(1)}%</span>
    </div>
  )
}

const MAX_BARS = 15
const MOBILE_MAX = 10

function SortToggle() {
  const [active] = useState<'meta' | 'winrate'>('meta')

  return (
    <div className="flex items-center gap-2 mb-3">
      <button
        className={active === 'meta' ? 'text-xs px-3 py-2 min-h-[44px] rounded-md bg-spark/10 text-spark' : 'text-xs px-3 py-2 min-h-[44px] rounded-md text-ash'}
      >
        Meta Share
      </button>
      <button
        className="text-xs px-3 py-2 min-h-[44px] rounded-md text-ash cursor-not-allowed opacity-50"
        title="Win rate requires match data"
        disabled
      >
        Win Rate
      </button>
    </div>
  )
}

function MobileMetaList({ data, format }: { data: MetaShareEntry[]; format: string }) {
  const items = data.slice(0, MOBILE_MAX)
  const maxShare = items[0]?.meta_share ?? 1

  return (
    <div className="space-y-2.5">
      {items.map(d => {
        const pct = (d.meta_share / maxShare) * 100
        return (
          <div key={d.archetype_id} className="flex items-center gap-2">
            <div className="flex items-center gap-1 w-[140px] shrink-0 min-w-0">
              <TierBadge tier={d.tier} />
              <Link
                href={`/data/${format}/${d.archetype_id}`}
                className="text-sm text-ink hover:text-spark transition-colors truncate"
              >
                {d.archetype_name}
              </Link>
            </div>
            <div className="flex-1 h-2 bg-edge rounded-full overflow-hidden">
              <div
                className="h-full bg-flame/60 rounded-full"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-ash tabular-nums text-glow">{d.meta_share.toFixed(1)}%</span>
          </div>
        )
      })}
    </div>
  )
}

export function MetaShareBar({ data, format }: { data: MetaShareEntry[]; format: string }) {
  const truncated = data.slice(0, MAX_BARS)
  const chartData = truncated.map(d => ({
    name: `${d.tier ?? ''}|${d.archetype_id}|${d.archetype_name}`,
    label: d.archetype_name,
    meta_share: d.meta_share,
  }))

  return (
    <div className="w-full">
      <SortToggle />

      {/* Mobile: list layout */}
      <div className="sm:hidden">
        <MobileMetaList data={data} format={format} />
      </div>

      {/* Desktop: Recharts bar chart */}
      <div className="hidden sm:block" style={{ height: Math.max(200, truncated.length * 32) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 160, right: 20, top: 5, bottom: 5 }}>
            <XAxis type="number" domain={[0, 'auto']} tickFormatter={v => `${v}%`} tick={{ fill: '#4A5878', fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="name"
              width={160}
              interval={0}
              tick={(props: Record<string, unknown>) => <CustomYTick {...(props as { x: number; y: number; payload: { value: string } })} format={format} />}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: '#172035', opacity: 0.5 }} />
            <Bar dataKey="meta_share" radius={[0, 4, 4, 0]} barSize={24}>
              {chartData.map((_, i) => (
                <Cell key={i} fill="#D4552A" fillOpacity={0.7} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
