'use client'

import Link from 'next/link'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import type { TrendPoint } from '@/app/data/[format]/queries'

const PALETTE = [
  '#4F8EF7',
  '#C9A050',
  '#D4552A',
  '#50B87A',
  '#B87333',
  '#A45CDB',
  '#E05F8A',
  '#4A5878',
]

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface border border-edge rounded-lg px-3 py-2 text-xs space-y-1">
      <div className="text-ash mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-ink">{p.name}</span>
          <span className="text-ash ml-auto">{p.value.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

export function TrendLines({ data, format }: { data: TrendPoint[]; format: string }) {
  // Need at least 3 unique windows to show trend lines
  const uniqueWindows = [...new Set(data.map(d => d.window_end))]
  if (uniqueWindows.length < 3) {
    return (
      <div className="text-sm text-ash py-6 text-center">
        Not enough history yet — trend lines appear after multiple weeks of data
      </div>
    )
  }

  // Build name→id map for legend links
  const nameToId = new Map<string, string>()
  for (const d of data) {
    if (!nameToId.has(d.archetype_name)) nameToId.set(d.archetype_name, d.archetype_id)
  }

  // Pivot: rows keyed by window_end, columns per archetype
  const archetypes = [...new Set(data.map(d => d.archetype_name))]
  const byWindow = new Map<string, Record<string, number>>()
  for (const d of data) {
    if (!byWindow.has(d.window_end)) byWindow.set(d.window_end, {})
    byWindow.get(d.window_end)![d.archetype_name] = d.meta_share
  }

  const chartData = [...byWindow.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([window_end, shares]) => ({
      window_end: new Date(window_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ...shares,
    }))

  return (
    <div className="w-full h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
          <XAxis dataKey="window_end" tick={{ fill: '#4A5878', fontSize: 11 }} />
          <YAxis tickFormatter={v => `${v}%`} tick={{ fill: '#4A5878', fontSize: 11 }} />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            content={({ payload }) => (
              <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2 text-ink">
                {payload?.map(entry => {
                  const id = nameToId.get(entry.value as string)
                  return (
                    <Link
                      key={entry.value as string}
                      href={`/data/${format}/${id}`}
                      className="flex items-center gap-1.5 hover:text-spark transition-colors"
                    >
                      <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                      <span>{entry.value}</span>
                    </Link>
                  )
                })}
              </div>
            )}
          />
          {archetypes.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
