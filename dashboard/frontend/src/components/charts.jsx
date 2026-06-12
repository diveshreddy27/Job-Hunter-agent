// Dependency-free SVG charts. All colors come from CSS variables so they
// respond to the light/dark theme automatically.
import { useEffect, useRef, useState } from 'react'

export const CHART_COLORS = [
  'rgb(var(--chart-1))', 'rgb(var(--chart-2))', 'rgb(var(--chart-3))',
  'rgb(var(--chart-4))', 'rgb(var(--chart-5))', 'rgb(var(--chart-6))',
]

export function scoreColor(s) {
  if (s == null) return 'rgb(var(--faint))'
  if (s >= 80) return 'rgb(var(--success))'
  if (s >= 60) return 'rgb(var(--chart-1))'
  if (s >= 40) return 'rgb(var(--warning))'
  return 'rgb(var(--danger))'
}

/* ── Donut / pie chart with legend ─────────────────────────────────────── */
export function DonutChart({ data, size = 168, thickness = 22, centerLabel, centerValue, colors = CHART_COLORS }) {
  const total = data.reduce((a, d) => a + d.value, 0)
  const r = (size - thickness) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  let offset = 0

  return (
    <div className="flex items-center gap-6 flex-wrap">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={c} cy={c} r={r} fill="none" stroke="rgb(var(--surface-2))" strokeWidth={thickness} />
          {total > 0 && data.map((d, i) => {
            const frac = d.value / total
            const seg = (
              <circle
                key={d.label} cx={c} cy={c} r={r} fill="none"
                stroke={d.color || colors[i % colors.length]}
                strokeWidth={thickness}
                strokeDasharray={`${frac * circ} ${circ}`}
                strokeDashoffset={-offset * circ}
                style={{ transition: 'stroke-dasharray .6s ease' }}
              >
                <title>{`${d.label}: ${d.value} (${Math.round(frac * 100)}%)`}</title>
              </circle>
            )
            offset += frac
            return seg
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-ink leading-none">{centerValue ?? total}</span>
          {centerLabel && <span className="text-[10px] uppercase tracking-wider text-muted mt-1">{centerLabel}</span>}
        </div>
      </div>
      <div className="space-y-2 min-w-0">
        {data.map((d, i) => (
          <div key={d.label} className="flex items-center gap-2 text-xs">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color || colors[i % colors.length] }} />
            <span className="text-muted capitalize truncate">{d.label}</span>
            <span className="font-mono font-semibold text-ink ml-auto pl-3">
              {d.value}
              <span className="text-faint font-normal ml-1">({total ? Math.round(d.value / total * 100) : 0}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Area / line chart ─────────────────────────────────────────────────── */
export function AreaChart({ data, height = 180, color = 'rgb(var(--chart-1))', valueSuffix = '', maxY }) {
  // data: [{ x: 'label', y: number }]
  const [hover, setHover] = useState(null)
  const gid = useRef('g' + Math.random().toString(36).slice(2)).current
  if (!data.length) return <Empty height={height} />

  const W = 600, H = height, padL = 6, padR = 6, padT = 14, padB = 22
  const max = maxY ?? Math.max(...data.map(d => d.y), 1)
  const stepX = data.length > 1 ? (W - padL - padR) / (data.length - 1) : 0
  const px = i => padL + i * stepX
  const py = v => padT + (H - padT - padB) * (1 - v / max)

  const pts = data.map((d, i) => `${px(i)},${py(d.y)}`).join(' ')
  const area = `${padL},${H - padB} ${pts} ${px(data.length - 1)},${H - padB}`
  const labelEvery = Math.ceil(data.length / 8)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}
      onMouseLeave={() => setHover(null)}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1={padL} x2={W - padR} y1={padT + (H - padT - padB) * f} y2={padT + (H - padT - padB) * f}
          stroke="rgb(var(--line))" strokeDasharray="4 6" strokeWidth="1" />
      ))}
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <g key={i}>
          <rect x={px(i) - stepX / 2} y={0} width={Math.max(stepX, 8)} height={H}
            fill="transparent" onMouseEnter={() => setHover(i)} />
          <circle cx={px(i)} cy={py(d.y)} r={hover === i ? 5 : 3} fill={color}
            stroke="rgb(var(--surface))" strokeWidth="2" />
          {i % labelEvery === 0 && (
            <text x={px(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="rgb(var(--faint))">{d.x}</text>
          )}
        </g>
      ))}
      {hover != null && (
        <g>
          <rect x={Math.min(Math.max(px(hover) - 42, 2), W - 86)} y={Math.max(py(data[hover].y) - 34, 2)}
            width="84" height="24" rx="6" fill="rgb(var(--ink))" opacity="0.92" />
          <text x={Math.min(Math.max(px(hover), 44), W - 44)} y={Math.max(py(data[hover].y) - 18, 18)}
            textAnchor="middle" fontSize="11" fontWeight="600" fill="rgb(var(--bg))">
            {data[hover].x}: {data[hover].y}{valueSuffix}
          </text>
        </g>
      )}
    </svg>
  )
}

/* ── Horizontal bar list ───────────────────────────────────────────────── */
export function HBarList({ items, color = 'rgb(var(--chart-1))', suffix = '', showPct = false }) {
  // items: [{ label, value, sub?, color? }]
  const max = Math.max(...items.map(i => i.value), 1)
  if (!items.length) return <Empty height={120} />
  return (
    <div className="space-y-3">
      {items.map(it => (
        <div key={it.label}>
          <div className="flex justify-between items-baseline mb-1 gap-3">
            <span className="text-xs font-medium text-ink truncate capitalize">{it.label}</span>
            <span className="text-xs font-mono text-muted shrink-0">
              {it.value}{suffix}{showPct && <span className="text-faint ml-1">({Math.round(it.value / max * 100)}%)</span>}
              {it.sub && <span className="text-faint ml-1">{it.sub}</span>}
            </span>
          </div>
          <div className="h-2 w-full bg-surface-2 rounded-full overflow-hidden">
            <GrowBar pct={it.value / max * 100} color={it.color || color} />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Vertical bar chart ────────────────────────────────────────────────── */
export function ColumnChart({ data, height = 160, color = 'rgb(var(--chart-1))' }) {
  // data: [{ x, y }]
  if (!data.length) return <Empty height={height} />
  const max = Math.max(...data.map(d => d.y), 1)
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map(d => (
        <div key={d.x} className="flex-1 flex flex-col items-center gap-1.5 min-w-0 h-full justify-end" title={`${d.x}: ${d.y}`}>
          <span className="text-[10px] font-mono text-muted">{d.y}</span>
          <div className="w-full rounded-t-md transition-all duration-700 hover:opacity-80"
            style={{ height: `${Math.max(d.y / max * 75, 2)}%`, background: d.color || color }} />
          <span className="text-[10px] text-faint truncate w-full text-center">{d.x}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Circular score ring ───────────────────────────────────────────────── */
export function ScoreRing({ score, size = 140, thickness = 11, label = 'ATS Score' }) {
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  const ref = useRef(null)
  useEffect(() => {
    const t = setTimeout(() => {
      if (ref.current) ref.current.style.strokeDashoffset = circ * (1 - (score || 0) / 100)
    }, 100)
    return () => clearTimeout(t)
  }, [score, circ])

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-2))" strokeWidth={thickness} />
        <circle ref={ref} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={scoreColor(score)}
          strokeWidth={thickness} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ}
          style={{ transition: 'stroke-dashoffset 1s ease' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-bold leading-none text-ink" style={{ fontSize: size / 3.6 }}>{score ?? '—'}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted mt-1">{label}</span>
      </div>
    </div>
  )
}

/* ── Animated progress bar ─────────────────────────────────────────────── */
export function GrowBar({ pct, color }) {
  const ref = useRef(null)
  useEffect(() => {
    const t = setTimeout(() => { if (ref.current) ref.current.style.width = Math.min(pct, 100) + '%' }, 120)
    return () => clearTimeout(t)
  }, [pct])
  return <div ref={ref} className="h-full rounded-full" style={{ width: '0%', background: color, transition: 'width .7s ease' }} />
}

function Empty({ height }) {
  return (
    <div className="flex items-center justify-center text-faint text-xs" style={{ height }}>
      No data yet — run the pipeline
    </div>
  )
}
