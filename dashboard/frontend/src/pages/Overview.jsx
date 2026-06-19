import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { DonutChart, AreaChart, scoreColor, GrowBar } from '../components/charts'
import { PageHeader, Card, StatCard, ScoreChip, ModePill, EmptyState, Skeleton, StatCardSkeleton } from '../components/ui'

function useCountUp(target, duration = 750) {
  const [val, setVal] = useState(0)
  const raf = useRef(null)
  useEffect(() => {
    const n = Number(target)
    if (!n) { setVal(0); return }
    let start = null
    const tick = (ts) => {
      if (!start) start = ts
      const p = Math.min((ts - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(eased * n))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration])
  return val
}

function staggerDelay(i, step = 0.055, cap = 0.48) {
  return `${Math.min(i * step, cap)}s`
}

function AnimatedStatCard({ icon, label, value, sub, tone }) {
  const counted = useCountUp(typeof value === 'number' ? value : 0)
  return <StatCard icon={icon} label={label} value={typeof value === 'number' ? counted : value} sub={sub} tone={tone} />
}

const BAND_COLORS = {
  '80-100': 'rgb(var(--success))',
  '60-79':  'rgb(var(--chart-1))',
  '40-59':  'rgb(var(--warning))',
  '<40':    'rgb(var(--danger))',
}
const MODE_COLORS = {
  remote: 'rgb(var(--chart-2))',
  hybrid: 'rgb(var(--chart-3))',
  onsite: 'rgb(var(--chart-4))',
  unknown: 'rgb(var(--chart-6))',
}
const CLOUD_FIT_COLORS = {
  aws_match: 'rgb(var(--success))',
  no_cloud_req: 'rgb(var(--chart-1))',
  other_cloud_only: 'rgb(var(--warning))',
  unknown: 'rgb(var(--chart-6))',
}
const CLOUD_FIT_LABEL = {
  aws_match: 'AWS match',
  no_cloud_req: 'No cloud req',
  other_cloud_only: 'Other cloud',
  unknown: 'unknown',
}

export default function Overview() {
  const [stats, setStats] = useState(null)
  const [jobs, setJobs] = useState([])

  useEffect(() => {
    Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/jobs?sort=score').then(r => r.json()),
    ]).then(([s, j]) => { setStats(s); setJobs(j) })
  }, [])

  if (!stats) return <OverviewSkeleton />

  const funnel = [
    { label: 'Scraped',   value: stats.raw_total,  icon: 'hub',              hint: 'posts survived pre-filters' },
    { label: 'Extracted', value: stats.normalized, icon: 'data_exploration', hint: 'parsed by Gemini AI' },
    { label: 'Targeted',  value: stats.targeted,   icon: 'rule',             hint: 'passed location + exp filter' },
    { label: 'Scored',    value: stats.scored,     icon: 'verified',         hint: 'full ATS evaluation' },
  ]

  const bandData = Object.entries(BAND_COLORS)
    .map(([band, color]) => ({ label: band, value: (stats.score_bands || {})[band] || 0, color }))
    .filter(d => d.value > 0)

  const modeData = Object.entries(stats.work_modes || {})
    .map(([mode, value]) => ({ label: mode, value, color: MODE_COLORS[mode] || MODE_COLORS.unknown }))
    .sort((a, b) => b.value - a.value)

  const statusData = [
    { label: 'done',    value: (stats.by_status || {}).done || 0,    color: 'rgb(var(--success))' },
    { label: 'pending', value: (stats.by_status || {}).pending || 0, color: 'rgb(var(--warning))' },
    { label: 'failed',  value: (stats.by_status || {}).failed || 0,  color: 'rgb(var(--danger))' },
  ].filter(d => d.value > 0)

  const cloudData = Object.entries(stats.cloud_fit || {})
    .map(([fit, value]) => ({ label: CLOUD_FIT_LABEL[fit] || fit, value, color: CLOUD_FIT_COLORS[fit] || CLOUD_FIT_COLORS.unknown }))
    .sort((a, b) => b.value - a.value)

  const trend = (stats.by_date || []).map(d => ({ x: d.date.slice(5), y: d.cnt }))
  const top5 = jobs.slice(0, 5)

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Pipeline intelligence across ${stats.raw_total} scraped posts. Last run ${stats.last_run}.`}
      >
        <span className="inline-flex items-center gap-2 px-3.5 py-1.5 card rounded-full text-xs font-semibold text-success">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
          </span>
          Agent Active
        </span>
      </PageHeader>

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <div className="fade-up fade-up-1"><AnimatedStatCard icon="travel_explore" label="Posts Scraped" value={stats.raw_total} sub={`${(stats.by_status || {}).pending || 0} pending extraction`} tone="info" /></div>
        <div className="fade-up fade-up-2"><AnimatedStatCard icon="verified" label="Jobs Scored" value={stats.scored} sub={`of ${stats.targeted} targeted · avg ${stats.avg_score ?? '—'}`} tone="accent" /></div>
        <div className="fade-up fade-up-3"><AnimatedStatCard icon="local_fire_department" label="Hot Leads" value={stats.hot_leads ?? 0} sub="fresh ≤48h · AWS · score ≥ 60" tone="warning" /></div>
        <div className="fade-up fade-up-4"><AnimatedStatCard icon="workspace_premium" label="Elite Matches" value={stats.high_match_80} sub="score ≥ 80 — apply first" tone="success" /></div>
      </div>

      {/* Funnel + score distribution */}
      <div className="grid grid-cols-12 gap-5 mb-6 fade-up" style={{ animationDelay: '0.18s' }}>
        <Card className="col-span-12 xl:col-span-7" title="Pipeline Funnel" icon="filter_alt">
          <div className="grid grid-cols-4 gap-3">
            {funnel.map((st, i) => {
              const prev = i > 0 ? funnel[i - 1].value : null
              const conv = prev ? Math.round((st.value / prev) * 100) : null
              return (
                <div key={st.label} className="relative text-center p-4 rounded-xl bg-surface-2/70 border border-line/60 hover:border-accent/40 transition-colors">
                  <span className="material-symbols-outlined gradient-text text-[26px]">{st.icon}</span>
                  <p className="text-3xl font-extrabold text-ink mt-2 leading-8 tracking-tight">{st.value}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted mt-1">{st.label}</p>
                  <p className="text-[10px] text-faint mt-0.5 leading-3.5">{st.hint}</p>
                  {conv != null && (
                    <span className="absolute -left-2.5 top-1/2 -translate-y-1/2 bg-surface border border-line rounded-full px-1.5 py-0.5 text-[9px] font-mono font-bold text-muted z-10">
                      {conv}%
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-[11px] text-faint mt-4">
            Conversion between stages shows where jobs drop out — extraction failures, location/experience filters, and scoring backlog.
          </p>
        </Card>

        <Card className="col-span-12 xl:col-span-5" title="Score Distribution" icon="donut_large"
          action={<Link to="/jobs" className="text-accent text-xs font-semibold hover:underline">View jobs →</Link>}>
          {bandData.length
            ? <DonutChart data={bandData} centerLabel="scored" centerValue={stats.scored} />
            : <EmptyState icon="scoreboard" title="No scored jobs yet" hint="Run the pipeline to score jobs against your resume." />}
        </Card>
      </div>

      {/* Activity trend + work mode + cloud fit */}
      <div className="grid grid-cols-12 gap-5 mb-6 fade-up" style={{ animationDelay: '0.26s' }}>
        <Card className="col-span-12 xl:col-span-6" title="Scrape Activity" icon="show_chart">
          <AreaChart data={trend} valueSuffix=" posts" />
        </Card>

        <Card className="col-span-12 md:col-span-6 xl:col-span-3" title="Work Mode" icon="pie_chart">
          {modeData.length
            ? <DonutChart data={modeData} size={140} thickness={18} centerLabel="extracted" centerValue={stats.normalized} />
            : <EmptyState icon="work_off" title="Nothing extracted yet" />}
        </Card>

        <Card className="col-span-12 md:col-span-6 xl:col-span-3" title="Cloud Fit" icon="cloud"
          action={<Link to="/jobs?cloud_fit=aws_match" className="text-accent text-xs font-semibold hover:underline">AWS →</Link>}>
          {cloudData.length
            ? <DonutChart data={cloudData} size={140} thickness={18} centerLabel="targeted" centerValue={stats.targeted} />
            : <EmptyState icon="cloud_off" title="No targeted jobs yet" />}
        </Card>
      </div>

      {/* Top jobs + extraction health */}
      <div className="grid grid-cols-12 gap-5 fade-up" style={{ animationDelay: '0.34s' }}>
        <Card className="col-span-12 xl:col-span-8" title="Top Scored Jobs" icon="trophy"
          action={<Link to="/jobs" className="text-accent text-xs font-semibold hover:underline">View all →</Link>}>
          {top5.length ? (
            <div className="divide-y divide-line -mx-2">
              {top5.map((j, i) => (
                <Link key={j.target_id} to={`/ats/${j.target_id}`}
                  className="flex items-center gap-4 px-2 py-3 hover:bg-surface-2 rounded-lg transition-colors group fade-up"
                  style={{ animationDelay: staggerDelay(i, 0.06, 0.35) }}>
                  <ScoreChip score={j.final_ats_score} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink text-sm truncate group-hover:text-accent transition-colors">{j.title || 'Untitled'}</p>
                    <p className="text-xs text-muted truncate">{[j.company, j.location].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  <ModePill mode={j.work_mode} />
                  <div className="text-right shrink-0 w-20">
                    <p className="text-sm font-bold" style={{ color: scoreColor(j.final_ats_score) }}>
                      {j.interview_probability != null ? j.interview_probability + '%' : '—'}
                    </p>
                    <p className="text-[10px] text-faint">interview</p>
                  </div>
                  <span className="material-symbols-outlined text-faint group-hover:text-accent group-hover:translate-x-0.5 transition-all text-[20px]">chevron_right</span>
                </Link>
              ))}
            </div>
          ) : <EmptyState icon="work_off" title="No jobs scored yet" hint="Hit Run Pipeline to start hunting." />}
        </Card>

        <Card className="col-span-12 xl:col-span-4" title="Extraction Health" icon="monitor_heart">
          {statusData.length
            ? <DonutChart data={statusData} size={140} thickness={18} centerLabel="posts" centerValue={stats.raw_total} />
            : <EmptyState icon="database_off" title="No data" />}
          <div className="mt-5 pt-4 border-t border-line">
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted">Extraction success rate</span>
              <span className="font-mono font-bold text-ink">
                {stats.raw_total ? Math.round(stats.raw_done / stats.raw_total * 100) : 0}%
              </span>
            </div>
            <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
              <GrowBar pct={stats.raw_total ? stats.raw_done / stats.raw_total * 100 : 0} color="rgb(var(--success))" />
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}

// Loading placeholder that mirrors the page's real grid so nothing shifts on load.
function OverviewSkeleton() {
  return (
    <>
      <div className="flex flex-wrap justify-between items-end gap-4 mb-7">
        <div className="space-y-2.5">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
      </div>

      <div className="grid grid-cols-12 gap-5 mb-6">
        <div className="card rounded-2xl p-6 col-span-12 xl:col-span-7">
          <Skeleton className="h-4 w-36 mb-5" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="card rounded-2xl p-6 col-span-12 xl:col-span-5 flex flex-col items-center">
          <Skeleton className="h-4 w-36 mb-6 self-start" />
          <Skeleton className="h-36 w-36 rounded-full" />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-5">
        <div className="card rounded-2xl p-6 col-span-12 xl:col-span-6">
          <Skeleton className="h-4 w-32 mb-5" />
          <Skeleton className="h-28 w-full" />
        </div>
        {[0, 1].map(i => (
          <div key={i} className="card rounded-2xl p-6 col-span-12 md:col-span-6 xl:col-span-3 flex flex-col items-center">
            <Skeleton className="h-4 w-24 mb-6 self-start" />
            <Skeleton className="h-28 w-28 rounded-full" />
          </div>
        ))}
      </div>
    </>
  )
}
