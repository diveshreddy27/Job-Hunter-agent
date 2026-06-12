import { useEffect, useState } from 'react'
import { HBarList, ScoreRing } from '../components/charts'
import { PageHeader, Card, Loading, EmptyState } from '../components/ui'

export default function SkillsGap() {
  const [gaps, setGaps] = useState([])
  const [stats, setStats] = useState(null)
  const [jobs, setJobs] = useState([])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    Promise.all([
      fetch('/api/skills-gap').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/jobs').then(r => r.json()),
    ]).then(([g, s, j]) => { setGaps(g); setStats(s); setJobs(j) })
  }, [])

  if (!stats) return <Loading />

  const analyzed = stats.scored || 0

  // Aggregate recurring weaknesses + priority actions across all scored jobs
  const weakFreq = {}
  const actionFreq = {}
  const kwdFreq = {}
  jobs.forEach(j => {
    ;(j.priority_changes || []).forEach(a => { actionFreq[a] = (actionFreq[a] || 0) + 1 })
    ;(j.keyword_injections || []).forEach(k => { kwdFreq[k] = (kwdFreq[k] || 0) + 1 })
  })
  const topActions = Object.entries(actionFreq).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const sortedKwds = Object.entries(kwdFreq).sort((a, b) => b[1] - a[1]).slice(0, 40)
  const maxKwd = sortedKwds[0]?.[1] || 1
  const topGaps = gaps.slice(0, 3).map(g => g.skill)

  function copyAll() {
    navigator.clipboard.writeText(sortedKwds.map(([k]) => k).join(', '))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  return (
    <>
      <PageHeader
        title="Skills Gap Analysis"
        subtitle={`Your resume audited against ${analyzed} scored job${analyzed !== 1 ? 's' : ''} — what the market wants that you don't show yet.`}
      >
        {topGaps.length > 0 && (
          <div className="card rounded-xl px-4 py-2.5 flex items-center gap-3">
            <span className="material-symbols-outlined text-warning" style={{ fontVariationSettings: "'FILL' 1" }}>warning</span>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-faint font-bold">Top gaps</p>
              <p className="text-xs font-bold text-warning">{topGaps.join(' · ')}</p>
            </div>
          </div>
        )}
      </PageHeader>

      <div className="grid grid-cols-12 gap-5 mb-6">
        <Card className="col-span-12 lg:col-span-8" title="Market Demand: Missing Skills" icon="analytics"
          action={<span className="text-[11px] text-faint font-mono">N = {analyzed} jobs</span>}>
          {gaps.length
            ? <HBarList
                color="rgb(var(--danger))"
                items={gaps.slice(0, 12).map(g => ({ label: g.skill, value: g.count, sub: `/ ${analyzed} jobs (${g.pct}%)` }))} />
            : <EmptyState icon="psychology" title="No gap data yet" hint="Score some jobs first — gaps are computed from ATS results." />}
        </Card>

        <div className="card rounded-2xl col-span-12 lg:col-span-4 p-6 flex flex-col items-center justify-center text-center gap-4">
          <ScoreRing score={stats.avg_score} size={170} label="Avg ATS Score" />
          <p className="text-sm text-muted leading-5">
            Closing the top 3 gaps above is the fastest way to move this number.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-5 mb-6">
        <Card className="col-span-12" title="Most Recommended Resume Changes" icon="task_alt"
          action={<span className="text-[11px] text-faint font-mono">aggregated from all ATS evaluations</span>}>
          {topActions.length ? (
            <div className="grid md:grid-cols-2 gap-3">
              {topActions.map(([a, cnt], i) => (
                <div key={i} className="flex gap-3 p-3.5 bg-surface-2 rounded-xl">
                  <div className="w-7 h-7 rounded-full bg-accent text-accent-ink flex items-center justify-center font-bold text-xs shrink-0">{i + 1}</div>
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink leading-5">{a}</p>
                    <p className="text-[11px] text-faint mt-1">Recommended for {cnt} job{cnt > 1 ? 's' : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState icon="task_alt" title="No recommendations yet" />}
        </Card>
      </div>

      <Card title="Global Keyword Injections" icon="key"
        action={
          <button onClick={copyAll}
            className="border border-accent text-accent px-3.5 py-1.5 rounded-lg text-xs font-semibold hover:bg-accent/10 transition-colors">
            {copied ? '✓ Copied!' : `Copy all ${sortedKwds.length}`}
          </button>
        }>
        <p className="text-muted text-xs -mt-2 mb-4">Most-requested missing terms across all scored jobs. Bigger tier = more demand.</p>
        <div className="flex flex-wrap gap-2.5">
          {sortedKwds.map(([k, cnt]) => {
            const tier = cnt / maxKwd
            const cls = tier > 0.6
              ? 'bg-accent/15 text-accent font-bold'
              : tier > 0.3
              ? 'bg-info/10 text-info font-medium'
              : 'bg-surface-2 text-muted'
            return (
              <span key={k} title={`${cnt} job${cnt > 1 ? 's' : ''}`}
                className={`px-3 py-1.5 rounded-full text-xs font-mono ${cls}`}>
                {k}
              </span>
            )
          })}
          {!sortedKwds.length && <span className="text-faint text-xs">No keywords yet</span>}
        </div>
      </Card>
    </>
  )
}
