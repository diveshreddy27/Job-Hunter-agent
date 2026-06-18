import { useEffect, useState } from 'react'
import { scoreColor, DonutChart, HBarList, AreaChart } from '../components/charts'
import { PageHeader, StatCard, Card, relativeTime } from '../components/ui'

const STATUS_STYLE = {
  assessment:   { cls: 'bg-info/10 text-info',       label: 'Assessment',   icon: 'quiz'          },
  interviewing: { cls: 'bg-warning/10 text-warning', label: 'Interviewing', icon: 'groups'        },
  offer:        { cls: 'bg-success/10 text-success', label: 'Offer',        icon: 'celebration'   },
  rejected:     { cls: 'bg-danger/10 text-danger',   label: 'Rejected',     icon: 'cancel'        },
  applied:      { cls: 'bg-accent/10 text-accent',   label: 'Applied',      icon: 'outgoing_mail' },
  saved:        { cls: 'bg-faint/20 text-faint',     label: 'Saved',        icon: 'bookmark'      },
}

// Statuses that mean the recruiter actually responded back
const RESPONDED = ['assessment', 'interviewing', 'offer', 'rejected']

export default function AppliedAnalysis() {
  const [tracker, setTracker] = useState([])
  const [outreach, setOutreach] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch('/api/tracker').then(r => r.json()),
      fetch('/api/outreach').then(r => r.json()),
    ]).then(([t, o]) => {
      setTracker(t)
      setOutreach(o.rows || [])
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32 text-muted text-sm gap-3">
        <span className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        Loading analysis…
      </div>
    )
  }

  const sentEmails   = outreach.filter(o => o.status === 'sent')
  const failedEmails = outreach.filter(o => o.status === 'failed')

  // Applications: tracker rows
  const ACTIVE = ['applied', 'assessment', 'interviewing', 'offer', 'rejected']
  const applied      = tracker.filter(j => ACTIVE.includes(j.status))
  const assessment   = tracker.filter(j => j.status === 'assessment')
  const interviewing = tracker.filter(j => j.status === 'interviewing')
  const offers       = tracker.filter(j => j.status === 'offer')
  const rejected     = tracker.filter(j => j.status === 'rejected')

  // Recruiter responded = status moved beyond 'applied' (recruiter actually got back to you)
  // Sourced from outreach rows (each has tracker_status from the join)
  const responded   = sentEmails.filter(o => RESPONDED.includes(o.tracker_status))
  const awaiting    = sentEmails.filter(o => !RESPONDED.includes(o.tracker_status))
  const responseRate = sentEmails.length ? Math.round(responded.length / sentEmails.length * 100) : 0

  const avgScore = applied.length
    ? Math.round(applied.reduce((s, j) => s + (j.final_ats_score || 0), 0) / applied.length)
    : null

  const avgRespondedScore = responded.length
    ? Math.round(responded.reduce((s, o) => s + (o.final_ats_score || 0), 0) / responded.length)
    : null
  const avgAwaitingScore = awaiting.length
    ? Math.round(awaiting.reduce((s, o) => s + (o.final_ats_score || 0), 0) / awaiting.length)
    : null

  // Response breakdown by outcome
  const byStatus = RESPONDED.map(s => ({
    status: s,
    jobs: responded.filter(o => o.tracker_status === s),
    ...STATUS_STYLE[s],
  }))

  // Score bands
  const bands = [
    { label: '80–100', min: 80, max: 100, color: 'rgb(var(--success))' },
    { label: '60–79',  min: 60, max: 79,  color: 'rgb(var(--chart-4))' },
    { label: '40–59',  min: 40, max: 59,  color: 'rgb(var(--warning))' },
    { label: '< 40',   min: 0,  max: 39,  color: 'rgb(var(--danger))'  },
  ].map(b => ({
    ...b,
    count: applied.filter(j => (j.final_ats_score || 0) >= b.min && (j.final_ats_score || 0) <= b.max).length,
  }))

  // Timeline
  const byDate = {}
  sentEmails.forEach(e => {
    const d = (e.sent_at || '').slice(0, 10)
    if (d) byDate[d] = (byDate[d] || 0) + 1
  })
  const timeline = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([x, y]) => ({ x, y }))

  // Status donut
  const pureApplied = applied.length - assessment.length - interviewing.length - offers.length - rejected.length
  const statusDonut = [
    { label: 'Applied',      value: pureApplied,        color: 'rgb(var(--accent))'  },
    { label: 'Assessment',   value: assessment.length,  color: 'rgb(var(--info))'    },
    { label: 'Interviewing', value: interviewing.length, color: 'rgb(var(--warning))' },
    { label: 'Offer',        value: offers.length,       color: 'rgb(var(--success))' },
    { label: 'Rejected',     value: rejected.length,     color: 'rgb(var(--danger))'  },
  ].filter(d => d.value > 0)

  // Response outcome donut
  const responseDonut = byStatus
    .filter(s => s.jobs.length > 0)
    .map(s => ({
      label: s.label,
      value: s.jobs.length,
      color: s.status === 'assessment'   ? 'rgb(var(--info))'
           : s.status === 'interviewing' ? 'rgb(var(--warning))'
           : s.status === 'offer'        ? 'rgb(var(--success))'
           : 'rgb(var(--danger))',
    }))

  // Companies
  const companyMap = {}
  applied.forEach(j => {
    const co = j.company || 'Unknown'
    if (!companyMap[co]) companyMap[co] = { count: 0, scores: [] }
    companyMap[co].count++
    if (j.final_ats_score) companyMap[co].scores.push(j.final_ats_score)
  })
  const companies = Object.entries(companyMap)
    .map(([label, d]) => ({
      label,
      value: d.count,
      sub: d.scores.length
        ? `avg ${Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length)}`
        : '',
    }))
    .sort((a, b) => b.value - a.value).slice(0, 10)

  // Companies that responded
  const respCoMap = {}
  responded.forEach(o => {
    const co = o.company || 'Unknown'
    if (!respCoMap[co]) respCoMap[co] = { count: 0, scores: [], statuses: [] }
    respCoMap[co].count++
    if (o.final_ats_score) respCoMap[co].scores.push(o.final_ats_score)
    respCoMap[co].statuses.push(o.tracker_status)
  })
  const respondedCompanies = Object.entries(respCoMap)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([label, d]) => ({
      label,
      value: d.count,
      sub: d.statuses.map(s => STATUS_STYLE[s]?.label || s).join(', '),
    }))

  // AI model usage
  const modelMap = {}
  sentEmails.forEach(e => {
    const m = (e.model_used || 'unknown').split('/').pop().split('-').slice(0, 4).join('-')
    modelMap[m] = (modelMap[m] || 0) + 1
  })
  const models = Object.entries(modelMap).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))

  const modeMap = {}
  applied.forEach(j => { const m = j.work_mode || 'unknown'; modeMap[m] = (modeMap[m] || 0) + 1 })
  const modeDonut = Object.entries(modeMap).map(([label, value]) => ({ label, value }))

  return (
    <>
      <PageHeader
        title="Applied Analysis"
        subtitle="Track every application — recruiter responses, outcomes, score patterns, and email stats."
      />

      {/* ── KPIs ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-6 gap-4 mb-6">
        <StatCard icon="outgoing_mail"  label="Emails Sent"   value={sentEmails.length}    tone="accent" />
        <StatCard icon="fact_check"     label="Total Applied" value={applied.length}        tone="accent" />
        <StatCard icon="mark_chat_read" label="Recruiter Responses"
          value={responded.length}
          sub={sentEmails.length ? `${responseRate}% response rate` : '—'}               tone="info"   />
        <StatCard icon="forum"          label="Interviews"    value={interviewing.length + assessment.length}
          sub={applied.length ? `${Math.round((interviewing.length + assessment.length + offers.length) / applied.length * 100)}% rate` : '—'} tone="warning"/>
        <StatCard icon="celebration"    label="Offers"        value={offers.length}
          sub={applied.length ? `${Math.round(offers.length / applied.length * 100)}% offer rate` : '—'} tone="success"/>
        <StatCard icon="query_stats"    label="Avg ATS Score" value={avgScore ?? '—'}       tone="info"  />
      </div>

      {/* ── Funnel + Status donut ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
        <Card title="Application Funnel" icon="filter_alt">
          <div className="space-y-4 mt-2">
            {[
              { label: 'Saved',                         count: tracker.length,                                           color: 'rgb(var(--faint))'   },
              { label: 'Applied (Email Sent)',           count: sentEmails.length,                                        color: 'rgb(var(--accent))'  },
              { label: 'Recruiter Responded',           count: responded.length,                                          color: 'rgb(var(--info))'    },
              { label: 'Assessment / Interview',        count: assessment.length + interviewing.length + offers.length,   color: 'rgb(var(--warning))' },
              { label: 'Offer',                         count: offers.length,                                             color: 'rgb(var(--success))' },
            ].map(step => {
              const pct = tracker.length ? Math.round(step.count / tracker.length * 100) : 0
              return (
                <div key={step.label}>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <span className="text-[12px] font-semibold text-ink">{step.label}</span>
                    <span className="text-[11px] text-muted tabular-nums">
                      {step.count} <span className="text-faint ml-1">{pct}%</span>
                    </span>
                  </div>
                  <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${Math.max(pct, step.count > 0 ? 2 : 0)}%`, background: step.color }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card title="Application Status Breakdown" icon="donut_large">
          {statusDonut.length > 0
            ? <DonutChart data={statusDonut} centerLabel="Applied" centerValue={applied.length}
                colors={statusDonut.map(d => d.color)} />
            : <div className="py-12 text-center text-faint text-sm">No applications yet</div>}
        </Card>
      </div>

      {/* ── Score distribution + Timeline ────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
        <Card title="Score Distribution (Applied)" icon="bar_chart">
          <div className="space-y-4 mt-2">
            {bands.map(b => {
              const pct = applied.length ? Math.round(b.count / applied.length * 100) : 0
              return (
                <div key={b.label}>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <span className="text-[12px] font-mono font-semibold text-ink">{b.label}</span>
                    <span className="text-[11px] text-muted tabular-nums">
                      {b.count} jobs <span className="text-faint ml-1">{pct}%</span>
                    </span>
                  </div>
                  <div className="h-2.5 bg-surface-2 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${Math.max(pct, b.count > 0 ? 2 : 0)}%`, background: b.color }} />
                  </div>
                </div>
              )
            })}
          </div>
          {applied.length > 0 && (
            <div className="mt-5 pt-4 border-t border-line flex gap-6">
              <div>
                <p className="text-[10px] text-faint uppercase tracking-wider mb-0.5">Avg score</p>
                <p className="text-[22px] font-extrabold" style={{ color: scoreColor(avgScore) }}>{avgScore}</p>
              </div>
              <div>
                <p className="text-[10px] text-faint uppercase tracking-wider mb-0.5">High quality (≥60)</p>
                <p className="text-[22px] font-extrabold text-ink">
                  {applied.filter(j => (j.final_ats_score || 0) >= 60).length}
                  <span className="text-[13px] text-muted font-normal ml-1">/ {applied.length}</span>
                </p>
              </div>
            </div>
          )}
        </Card>

        <Card title="Applications Over Time" icon="timeline">
          {timeline.length > 1
            ? <AreaChart data={timeline} valueSuffix=" sent" />
            : <div className="py-12 text-center text-faint text-sm">
                {sentEmails.length === 0 ? 'No emails sent yet' : 'Send more emails to see a trend'}
              </div>}
        </Card>
      </div>

      {/* ── Companies + Work mode ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
        <Card title="Companies Applied To" icon="business">
          {companies.length > 0
            ? <HBarList items={companies} />
            : <div className="py-12 text-center text-faint text-sm">No applications yet</div>}
        </Card>
        <Card title="Work Mode Split" icon="location_on">
          {modeDonut.length > 0
            ? <DonutChart data={modeDonut} centerLabel="Jobs" centerValue={applied.length} />
            : <div className="py-12 text-center text-faint text-sm">No data</div>}
        </Card>
      </div>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* ── RECRUITER RESPONSE ANALYSIS ──────────────────────────────────── */}
      {/* ════════════════════════════════════════════════════════════════════ */}

      <div className="flex items-center gap-3 my-7">
        <div className="flex-1 h-px bg-line" />
        <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-info/10 border border-info/20">
          <span className="material-symbols-outlined text-[15px] text-info">mark_chat_read</span>
          <span className="text-[11px] font-bold text-info uppercase tracking-wider">Recruiter Response Analysis</span>
        </div>
        <div className="flex-1 h-px bg-line" />
      </div>

      {responded.length === 0 ? (
        <div className="card rounded-2xl py-14 text-center mb-5">
          <span className="material-symbols-outlined text-[44px] text-faint">hourglass_empty</span>
          <p className="text-ink font-semibold mt-3">No recruiter responses yet</p>
          <p className="text-muted text-sm mt-2 max-w-sm mx-auto leading-relaxed">
            When a recruiter responds — whether for an assessment, interview, or rejection —
            update the application status in the Outreach page. It will appear here.
          </p>
        </div>
      ) : (
        <>
          {/* Response KPIs */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-5">
            <div className="card rounded-2xl p-5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-faint mb-1">Response Rate</p>
              <p className="text-[36px] font-extrabold text-info leading-none">{responseRate}%</p>
              <p className="text-[11px] text-muted mt-1.5">
                {responded.length} of {sentEmails.length} emails got a response
              </p>
            </div>

            <div className="card rounded-2xl p-5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-faint mb-1">Avg Score — Got Response</p>
              <p className="text-[36px] font-extrabold leading-none" style={{ color: scoreColor(avgRespondedScore) }}>
                {avgRespondedScore ?? '—'}
              </p>
              <p className="text-[11px] text-muted mt-1.5">
                vs <span className="font-semibold">{avgAwaitingScore ?? '—'}</span> no response
                {avgRespondedScore != null && avgAwaitingScore != null && (
                  <span className={`ml-1.5 font-bold ${avgRespondedScore >= avgAwaitingScore ? 'text-success' : 'text-danger'}`}>
                    ({avgRespondedScore >= avgAwaitingScore ? '+' : ''}{avgRespondedScore - avgAwaitingScore} pts)
                  </span>
                )}
              </p>
            </div>

            <div className="card rounded-2xl p-5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-faint mb-1">Positive Responses</p>
              <p className="text-[36px] font-extrabold text-warning leading-none">
                {responded.filter(o => ['assessment', 'interviewing', 'offer'].includes(o.tracker_status)).length}
              </p>
              <p className="text-[11px] text-muted mt-1.5">Assessment + Interview + Offer</p>
            </div>

            <div className="card rounded-2xl p-5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-faint mb-1">Rejections</p>
              <p className="text-[36px] font-extrabold text-danger leading-none">
                {responded.filter(o => o.tracker_status === 'rejected').length}
              </p>
              <p className="text-[11px] text-muted mt-1.5">
                {responded.length
                  ? `${Math.round(responded.filter(o => o.tracker_status === 'rejected').length / responded.length * 100)}% rejection rate`
                  : '—'}
              </p>
            </div>
          </div>

          {/* Response outcome breakdown cards */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-5">
            {byStatus.map(s => (
              <div key={s.status} className={`card rounded-2xl p-4 border ${
                s.status === 'assessment'   ? 'border-info/20 bg-info/[0.03]'
              : s.status === 'interviewing' ? 'border-warning/20 bg-warning/[0.03]'
              : s.status === 'offer'        ? 'border-success/20 bg-success/[0.03]'
              : 'border-danger/20 bg-danger/[0.03]'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`material-symbols-outlined text-[18px] ${
                    s.status === 'assessment'   ? 'text-info'
                  : s.status === 'interviewing' ? 'text-warning'
                  : s.status === 'offer'        ? 'text-success'
                  : 'text-danger'}`}
                    style={{ fontVariationSettings: "'FILL' 1" }}>
                    {s.icon}
                  </span>
                  <span className="text-[11px] font-bold text-ink">{s.label}</span>
                </div>
                <p className="text-[32px] font-extrabold text-ink leading-none">{s.jobs.length}</p>
                {s.jobs.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {s.jobs.map(o => (
                      <div key={o.id} className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted truncate">{o.company || o.title || '—'}</span>
                        {o.final_ats_score != null && (
                          <span className="text-[10px] font-bold tabular-nums shrink-0"
                            style={{ color: scoreColor(o.final_ats_score) }}>
                            {o.final_ats_score}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Companies + response outcome donut */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
            <Card title="Companies That Responded" icon="business_center">
              <HBarList items={respondedCompanies} color="rgb(var(--info))" />
            </Card>

            <Card title="Response Outcome Mix" icon="donut_large">
              {responseDonut.length > 0
                ? <DonutChart data={responseDonut} centerLabel="Responses" centerValue={responded.length}
                    colors={responseDonut.map(d => d.color)} />
                : <div className="py-8 text-center text-faint text-sm">No data</div>}
            </Card>
          </div>

          {/* Score: responded vs awaiting */}
          <Card title="Does ATS Score Influence Recruiter Response?" icon="insights" className="mb-5">
            <p className="text-[11px] text-muted mb-6">
              Avg ATS score of applications that got a recruiter response vs those still awaiting.
            </p>
            <div className="flex flex-wrap gap-10 items-end">
              {[
                { label: 'Got Response',    score: avgRespondedScore, count: responded.length,  primary: true  },
                { label: 'No Response Yet', score: avgAwaitingScore,  count: awaiting.length,   primary: false },
              ].map(g => (
                <div key={g.label} className="min-w-[150px]">
                  <p className="text-[10px] text-faint uppercase tracking-wider mb-1">{g.label}</p>
                  <p className="text-[30px] font-extrabold leading-none"
                    style={{ color: g.primary ? scoreColor(g.score) : 'rgb(var(--muted))' }}>
                    {g.score ?? '—'}
                  </p>
                  <div className="h-2 w-40 bg-surface-2 rounded-full mt-2.5 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{
                        width: `${g.score ?? 0}%`,
                        background: g.primary ? scoreColor(g.score) : 'rgb(var(--faint))',
                      }} />
                  </div>
                  <p className="text-[10px] text-muted mt-1.5">{g.count} application{g.count !== 1 ? 's' : ''}</p>
                </div>
              ))}

              {avgRespondedScore != null && avgAwaitingScore != null && (
                <div className="ml-auto text-right">
                  <p className="text-[10px] text-faint uppercase tracking-wider mb-1">Difference</p>
                  <p className={`text-[28px] font-extrabold ${avgRespondedScore >= avgAwaitingScore ? 'text-success' : 'text-danger'}`}>
                    {avgRespondedScore >= avgAwaitingScore ? '+' : ''}{avgRespondedScore - avgAwaitingScore}
                  </p>
                  <p className="text-[10px] text-muted">pts</p>
                  <p className="text-[10px] text-faint mt-2 max-w-[140px] text-right leading-relaxed">
                    {avgRespondedScore > avgAwaitingScore
                      ? 'Higher-scored applications are getting responses'
                      : avgRespondedScore === avgAwaitingScore
                      ? 'Score had no effect on response rate'
                      : 'Lower-scored applications got more responses — content matters more than score'}
                  </p>
                </div>
              )}
            </div>
          </Card>

          {/* All responded jobs detail */}
          <Card title="All Recruiter Responses" icon="mark_chat_read">
            <div className="overflow-x-auto custom-scrollbar -mx-6 px-6">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-line">
                    {['Job', 'Company', 'Recruiter', 'Score', 'Response', 'Email Sent'].map(h => (
                      <th key={h} className="pb-2.5 pr-5 text-[10px] font-bold uppercase tracking-wider text-faint">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {responded.map(o => {
                    const ss = STATUS_STYLE[o.tracker_status] || STATUS_STYLE.applied
                    return (
                      <tr key={o.id} className="hover:bg-surface-2/50 transition-colors">
                        <td className="py-3 pr-5 text-[12px] font-semibold text-ink max-w-[160px] truncate">{o.title || '—'}</td>
                        <td className="py-3 pr-5 text-[11px] text-muted max-w-[120px] truncate">{o.company || '—'}</td>
                        <td className="py-3 pr-5 text-[11px] text-muted max-w-[120px] truncate">
                          {o.recruiter_name || '—'}
                          {o.to_email && <p className="text-[9px] text-faint font-mono mt-0.5">{o.to_email}</p>}
                        </td>
                        <td className="py-3 pr-5">
                          {o.final_ats_score != null
                            ? <span className="text-[13px] font-bold tabular-nums"
                                style={{ color: scoreColor(o.final_ats_score) }}>{o.final_ats_score}</span>
                            : <span className="text-faint text-[11px]">—</span>}
                        </td>
                        <td className="py-3 pr-5">
                          <span className={`flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full font-semibold uppercase tracking-wide w-fit ${ss.cls}`}>
                            <span className="material-symbols-outlined text-[12px]"
                              style={{ fontVariationSettings: "'FILL' 1" }}>{ss.icon}</span>
                            {ss.label}
                          </span>
                        </td>
                        <td className="py-3 text-[11px] text-muted whitespace-nowrap tabular-nums">
                          {o.sent_at ? relativeTime(o.sent_at).text : '—'}
                          {o.sent_at && (
                            <p className="text-[9px] text-faint mt-0.5">
                              {new Date(o.sent_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </p>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* ── AI model + delivery ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mt-5 mb-5">
        <Card title="AI Model Used for Emails" icon="smart_toy">
          {models.length > 0
            ? <HBarList items={models} />
            : <div className="py-12 text-center text-faint text-sm">No emails sent yet</div>}
        </Card>
        <Card title="Email Delivery Stats" icon="mark_email_read">
          <div className="flex gap-8 items-center py-4">
            <div className="text-center">
              <p className="text-[38px] font-extrabold text-success leading-none">{sentEmails.length}</p>
              <p className="text-[11px] text-muted mt-1">Delivered</p>
            </div>
            <div className="text-center">
              <p className="text-[38px] font-extrabold text-danger leading-none">{failedEmails.length}</p>
              <p className="text-[11px] text-muted mt-1">Failed</p>
            </div>
            {(sentEmails.length + failedEmails.length) > 0 && (
              <div className="text-center">
                <p className="text-[38px] font-extrabold text-ink leading-none">
                  {Math.round(sentEmails.length / (sentEmails.length + failedEmails.length) * 100)}%
                </p>
                <p className="text-[11px] text-muted mt-1">Delivery rate</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ── Full email log ────────────────────────────────────────────────── */}
      <Card title="Full Email Log" icon="outgoing_mail">
        <div className="overflow-x-auto custom-scrollbar -mx-6 px-6">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-line">
                {['Job', 'Company', 'Score', 'Sent', 'Delivery', 'Recruiter Response', 'Model'].map(h => (
                  <th key={h} className="pb-2.5 pr-5 text-[10px] font-bold uppercase tracking-wider text-faint">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {outreach.map(e => {
                const responded = RESPONDED.includes(e.tracker_status)
                const ss = STATUS_STYLE[e.tracker_status]
                return (
                  <tr key={e.id} className={`hover:bg-surface-2/50 transition-colors ${responded ? 'bg-info/[0.025]' : ''}`}>
                    <td className="py-3 pr-5 text-[12px] font-medium text-ink max-w-[180px] truncate">{e.title || '—'}</td>
                    <td className="py-3 pr-5 text-[11px] text-muted max-w-[120px] truncate">{e.company || '—'}</td>
                    <td className="py-3 pr-5">
                      {e.final_ats_score != null
                        ? <span className="text-[12px] font-bold tabular-nums" style={{ color: scoreColor(e.final_ats_score) }}>{e.final_ats_score}</span>
                        : <span className="text-faint text-[11px]">—</span>}
                    </td>
                    <td className="py-3 pr-5 text-[11px] text-muted whitespace-nowrap tabular-nums">
                      {e.sent_at ? relativeTime(e.sent_at).text : '—'}
                    </td>
                    <td className="py-3 pr-5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide ${
                        e.status === 'sent' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                        {e.status}
                      </span>
                    </td>
                    <td className="py-3 pr-5">
                      {ss && responded
                        ? <span className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide w-fit ${ss.cls}`}>
                            <span className="material-symbols-outlined text-[11px]"
                              style={{ fontVariationSettings: "'FILL' 1" }}>{ss.icon}</span>
                            {ss.label}
                          </span>
                        : <span className="text-[11px] text-faint">Awaiting</span>}
                    </td>
                    <td className="py-3 text-[10px] text-faint font-mono max-w-[150px] truncate">
                      {(e.model_used || '—').split('/').pop()}
                    </td>
                  </tr>
                )
              })}
              {outreach.length === 0 && (
                <tr><td colSpan="7" className="py-12 text-center text-faint text-sm">No emails sent yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
