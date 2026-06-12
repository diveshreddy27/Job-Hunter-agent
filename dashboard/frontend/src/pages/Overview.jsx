import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DonutChart, AreaChart, scoreColor, GrowBar } from '../components/charts'
import { PageHeader, Card, StatCard, ScoreChip, ModePill, Loading, EmptyState } from '../components/ui'

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

export default function Overview() {
  const [stats, setStats] = useState(null)
  const [jobs, setJobs] = useState([])

  useEffect(() => {
    Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/jobs?sort=score').then(r => r.json()),
    ]).then(([s, j]) => { setStats(s); setJobs(j) })
  }, [])

  if (!stats) return <Loading />

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

  const trend = (stats.by_date || []).map(d => ({ x: d.date.slice(5), y: d.cnt }))
  const top5 = jobs.slice(0, 5)

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Pipeline intelligence across ${stats.raw_total} scraped posts. Last run ${stats.last_run}.`}
      >
        <span className="inline-flex items-center gap-2 px-3 py-1.5 card rounded-full text-xs font-semibold text-success">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" /> Agent Active
        </span>
      </PageHeader>

      {/* KPI cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <StatCard icon="travel_explore" label="Posts Scraped" value={stats.raw_total} sub={`${(stats.by_status || {}).pending || 0} pending extraction`} tone="info" />
        <StatCard icon="verified" label="Jobs Scored" value={stats.scored} sub={`of ${stats.targeted} targeted`} tone="accent" />
        <StatCard icon="speed" label="Avg ATS Score" value={stats.avg_score ?? '—'} sub="across all scored jobs" tone="warning" />
        <StatCard icon="workspace_premium" label="Elite Matches" value={stats.high_match_80} sub="score ≥ 80 — apply first" tone="success" />
      </div>

      {/* Funnel + score distribution */}
      <div className="grid grid-cols-12 gap-5 mb-6">
        <Card className="col-span-12 xl:col-span-7" title="Pipeline Funnel" icon="filter_alt">
          <div className="grid grid-cols-4 gap-3">
            {funnel.map((st, i) => {
              const prev = i > 0 ? funnel[i - 1].value : null
              const conv = prev ? Math.round((st.value / prev) * 100) : null
              return (
                <div key={st.label} className="relative text-center p-4 rounded-xl bg-surface-2">
                  <span className="material-symbols-outlined text-accent text-[26px]">{st.icon}</span>
                  <p className="text-3xl font-bold text-ink mt-2 leading-8">{st.value}</p>
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

      {/* Activity trend + work mode */}
      <div className="grid grid-cols-12 gap-5 mb-6">
        <Card className="col-span-12 xl:col-span-7" title="Scrape Activity" icon="show_chart">
          <AreaChart data={trend} valueSuffix=" posts" />
        </Card>

        <Card className="col-span-12 xl:col-span-5" title="Work Mode Split" icon="pie_chart">
          {modeData.length
            ? <DonutChart data={modeData} centerLabel="extracted" centerValue={stats.normalized} />
            : <EmptyState icon="work_off" title="Nothing extracted yet" />}
        </Card>
      </div>

      {/* Top jobs + extraction health */}
      <div className="grid grid-cols-12 gap-5">
        <Card className="col-span-12 xl:col-span-8" title="Top Scored Jobs" icon="trophy"
          action={<Link to="/jobs" className="text-accent text-xs font-semibold hover:underline">View all →</Link>}>
          {top5.length ? (
            <div className="divide-y divide-line -mx-2">
              {top5.map(j => (
                <Link key={j.target_id} to={`/ats/${j.target_id}`}
                  className="flex items-center gap-4 px-2 py-3 hover:bg-surface-2 rounded-lg transition-colors group">
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
