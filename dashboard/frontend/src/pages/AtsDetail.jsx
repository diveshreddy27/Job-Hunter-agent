import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ScoreRing, scoreColor, GrowBar } from '../components/charts'
import EmailComposer from '../components/EmailComposer'
import { Card, TRACKER_META, CloudFitPill, CloudChips, relativeTime, EmptyState, Loading, selectCls } from '../components/ui'

const SUB_SCORES = [
  ['keyword_match_score', 'Keyword Match'],
  ['semantic_alignment_score', 'Semantic Alignment'],
  ['technical_skills_score', 'Technical Skills'],
  ['experience_relevance_score', 'Experience Relevance'],
  ['project_alignment_score', 'Project Alignment'],
  ['seniority_fit_score', 'Seniority Fit'],
  ['domain_fit_score', 'Domain Fit'],
  ['impact_score', 'Resume Impact'],
  ['ats_structure_score', 'ATS Structure'],
  ['recruiter_readability_score', 'Recruiter Readability'],
  ['tailoring_readiness_score', 'Tailoring Readiness'],
]

function scoreLabel(s) {
  if (s == null) return 'Not scored'
  if (s >= 80) return 'Elite Match'
  if (s >= 60) return 'Strong Match'
  if (s >= 40) return 'Developing'
  return 'Low Match'
}

export default function AtsDetail() {
  const { id } = useParams()
  const [job, setJob] = useState(null)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)
  const [composing, setComposing] = useState(false)   // email composer open?

  useEffect(() => {
    fetch(`/api/jobs/${id}`)
      .then(r => r.json())
      .then(d => { d.error ? setError(true) : setJob(d) })
      .catch(() => setError(true))
  }, [id])

  async function setTrackerStatus(status) {
    if (!status) {
      await fetch(`/api/tracker/${id}`, { method: 'DELETE' })
      setJob(j => ({ ...j, tracker_status: null }))
      return
    }
    await fetch(`/api/tracker/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setJob(j => ({ ...j, tracker_status: status }))
  }

  function copyKeywords() {
    navigator.clipboard.writeText((job.keyword_injections || []).join(', '))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  if (error) return <EmptyState icon="error" title="Job not found" hint="It may have been removed from the database." />
  if (!job) return <Loading />

  const sc = job.final_ats_score
  const PROBS = [
    ['ATS Pass', job.ats_pass_probability, 'rgb(var(--chart-1))'],
    ['Shortlist', job.shortlist_probability, 'rgb(var(--chart-2))'],
    ['Interview', job.interview_probability, 'rgb(var(--chart-3))'],
    ['Rejection', job.rejection_probability, 'rgb(var(--danger))'],
  ]

  return (
    <>
      {/* Breadcrumb + header */}
      <div className="flex flex-wrap justify-between items-start gap-4 mb-7">
        <div>
          <nav className="flex items-center gap-1.5 text-faint text-xs mb-2">
            <Link to="/" className="hover:text-accent">Overview</Link>
            <span className="material-symbols-outlined text-[14px]">chevron_right</span>
            <Link to="/jobs" className="hover:text-accent">Jobs</Link>
            <span className="material-symbols-outlined text-[14px]">chevron_right</span>
            <span className="text-accent">{job.title || '—'}</span>
          </nav>
          <h2 className="text-[26px] font-bold leading-9 text-ink tracking-tight">{job.title || 'Untitled'}</h2>
          <p className="text-muted text-sm mt-1">
            {[job.company, job.location, job.work_mode].filter(Boolean).join(' · ') || '—'}
          </p>
          <div className="flex items-center gap-2.5 mt-2.5 flex-wrap">
            <CloudFitPill fit={job.cloud_fit} />
            <CloudChips clouds={job.clouds_list} />
            {job.posted_at && (() => {
              const age = relativeTime(job.posted_at)
              return (
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${age.fresh ? 'text-success' : 'text-muted'}`}>
                  <span className="material-symbols-outlined text-[14px]">schedule</span>
                  Posted {age.text}
                </span>
              )
            })()}
            {job.experience_min != null && (
              <span className="text-[11px] text-muted font-mono">{job.experience_min}–{job.experience_max ?? '?'} yrs</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          <select
            value={job.tracker_status || ''}
            onChange={e => setTrackerStatus(e.target.value || null)}
            className={`${selectCls} !py-2 !rounded-xl font-semibold`}
          >
            <option value="">+ Track this job</option>
            {Object.entries(TRACKER_META).map(([s, m]) => <option key={s} value={s}>{m.label}</option>)}
          </select>
          {job.recruiter_email && (
            <button
              onClick={() => setComposing(true)}
              className="bg-accent text-accent-ink px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide hover:brightness-110 flex items-center gap-2 shadow-lg shadow-accent/25">
              <span className="material-symbols-outlined text-[18px]">send</span>
              Send Email
            </button>
          )}
          <a href={job.post_url || '#'} target="_blank" rel="noopener noreferrer"
            className="card text-muted px-4 py-2 rounded-xl text-xs font-bold hover:text-accent flex items-center gap-2 transition-colors">
            <span className="material-symbols-outlined text-[18px]">open_in_new</span>LinkedIn
          </a>
        </div>
      </div>

      {/* Score hero + breakdown + predictions */}
      <div className="grid grid-cols-12 gap-5 mb-6">
        <div className="card rounded-2xl col-span-12 md:col-span-3 p-6 flex flex-col items-center justify-center text-center gap-4">
          <ScoreRing score={sc} size={150} />
          <span className="text-xs font-bold px-3 py-1 rounded-full"
            style={{ background: `color-mix(in srgb, ${scoreColor(sc)} 15%, transparent)`, color: scoreColor(sc) }}>
            {scoreLabel(sc)}
          </span>
        </div>

        <Card className="col-span-12 md:col-span-5" title="Score Breakdown" icon="bar_chart">
          <div className="space-y-2.5">
            {SUB_SCORES.map(([key, label]) => {
              const v = job[key]
              if (v == null) return null
              return (
                <div key={key}>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs text-ink font-medium">{label}</span>
                    <span className="text-xs font-mono font-semibold" style={{ color: scoreColor(v) }}>{v}</span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <GrowBar pct={v} color={scoreColor(v)} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card className="col-span-12 md:col-span-4" title="Predictions" icon="online_prediction">
          <div className="space-y-3.5">
            {PROBS.map(([label, val, c]) => (
              <div key={label}>
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-ink font-medium">{label}</span>
                  <span className="text-xs font-bold" style={{ color: c }}>{val ?? 0}%</span>
                </div>
                <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                  <GrowBar pct={val ?? 0} color={c} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 pt-4 border-t border-line space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-faint font-semibold">Recruiter</p>
            <p className="font-bold text-ink text-sm">{job.recruiter_name || '—'}</p>
            {job.recruiter_email && (
              <a href={`mailto:${job.recruiter_email}`} className="text-accent text-xs hover:underline flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]">alternate_email</span>{job.recruiter_email}
              </a>
            )}
            <p className="text-muted text-xs">{[job.recruiter_designation, job.recruiter_current_company].filter(Boolean).join(' · ')}</p>
          </div>
        </Card>
      </div>

      {/* Skills */}
      <div className="grid grid-cols-12 gap-5 mb-6">
        <Card className="col-span-12 md:col-span-6" title="Matched Skills" icon="check_circle">
          <div className="flex flex-wrap gap-2">
            {(job.matched_skills || []).length
              ? job.matched_skills.map(s => (
                  <span key={s} className="px-3 py-1 bg-success/10 text-success rounded-full text-xs font-mono font-medium">{s}</span>
                ))
              : <span className="text-faint text-xs">None identified</span>}
          </div>
        </Card>
        <Card className="col-span-12 md:col-span-6" title="Critical Gaps" icon="cancel">
          <div className="flex flex-wrap gap-2">
            {(job.critical_gap_skills || []).length
              ? job.critical_gap_skills.map(s => (
                  <span key={s} className="px-3 py-1 bg-danger/10 text-danger rounded-full text-xs font-mono font-medium">{s}</span>
                ))
              : <span className="text-faint text-xs">No critical gaps identified</span>}
          </div>
        </Card>
      </div>

      {/* Actions + strengths + weaknesses */}
      <div className="grid grid-cols-12 gap-5 mb-6">
        <Card className="col-span-12 lg:col-span-4" title="Priority Actions" icon="task_alt">
          <div className="space-y-2.5">
            {(job.priority_changes || []).map((a, i) => (
              <div key={i} className="flex gap-3 p-3 bg-surface-2 rounded-xl">
                <div className="w-6 h-6 rounded-full bg-accent text-accent-ink flex items-center justify-center font-bold text-[11px] shrink-0 mt-0.5">{i + 1}</div>
                <p className="text-[13px] text-ink leading-5">{a}</p>
              </div>
            ))}
            {!(job.priority_changes || []).length && <span className="text-faint text-xs">No recommendations</span>}
          </div>
        </Card>
        <Card className="col-span-12 lg:col-span-4" title="Resume Strengths" icon="stars">
          <ul className="space-y-2">
            {(job.resume_strengths || []).map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-ink leading-5">
                <span className="material-symbols-outlined text-success text-[16px] mt-0.5 shrink-0">check</span>{s}
              </li>
            ))}
          </ul>
        </Card>
        <Card className="col-span-12 lg:col-span-4" title="Weaknesses" icon="warning">
          <ul className="space-y-2">
            {(job.resume_weaknesses || []).map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-ink leading-5">
                <span className="material-symbols-outlined text-warning text-[16px] mt-0.5 shrink-0">priority_high</span>{s}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Keyword injections */}
      <Card className="mb-6" title="Keyword Injections" icon="key"
        action={
          <button onClick={copyKeywords}
            className="border border-accent text-accent px-3.5 py-1.5 rounded-lg text-xs font-semibold hover:bg-accent/10 transition-colors">
            {copied ? '✓ Copied!' : 'Copy all'}
          </button>
        }>
        <div className="flex flex-wrap gap-2">
          {(job.keyword_injections || []).map(k => (
            <span key={k} className="px-3 py-1.5 bg-accent/10 text-accent rounded-full text-xs font-mono font-medium">{k}</span>
          ))}
          {!(job.keyword_injections || []).length && <span className="text-faint text-xs">None suggested</span>}
        </div>
      </Card>

      {/* Outreach playbook — what the recruiter explicitly asked for */}
      {(job.email_subject_format || (job.email_required_list || []).length || (job.outreach_history || []).length) ? (
        <Card className="mb-6" title="Outreach Playbook" icon="contact_mail">
          <div className="grid grid-cols-12 gap-5">
            <div className="col-span-12 md:col-span-6 space-y-4">
              {job.email_subject_format && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1.5">Required subject format</p>
                  <code className="block bg-surface-2 rounded-lg px-3 py-2 text-xs text-ink font-mono break-words">{job.email_subject_format}</code>
                </div>
              )}
              <div>
                <p className="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1.5">Fields the recruiter asked for</p>
                {(job.email_required_list || []).length ? (
                  <div className="flex flex-wrap gap-2">
                    {job.email_required_list.map(f => (
                      <span key={f} className="px-2.5 py-1 bg-warning/10 text-warning rounded-full text-[11px] font-mono font-medium">
                        {f.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                ) : <span className="text-faint text-xs">No specific fields requested — standard application.</span>}
              </div>
            </div>
            <div className="col-span-12 md:col-span-6">
              <p className="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1.5">Email history</p>
              {(job.outreach_history || []).length ? (
                <div className="space-y-2">
                  {job.outreach_history.map((o, i) => (
                    <div key={i} className="bg-surface-2 rounded-lg p-3 text-xs">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className={`font-bold uppercase text-[10px] px-2 py-0.5 rounded-full ${o.status === 'sent' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>{o.status}</span>
                        <span className="text-faint font-mono">{o.sent_at ? o.sent_at.replace('T', ' ') : '—'}</span>
                      </div>
                      <p className="text-ink font-medium truncate">{o.subject || '—'}</p>
                      {o.error && <p className="text-danger mt-0.5">{o.error}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-faint text-xs bg-surface-2 rounded-lg p-3">
                  <span className="material-symbols-outlined text-[16px]">outgoing_mail</span>
                  No email sent yet{job.recruiter_email ? ' — use Send Email above.' : '.'}
                </div>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {/* Raw post */}
      <Card title="Full Job Post" icon="description">
        <pre className="text-xs font-mono text-muted whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto custom-scrollbar">
          {job.post_content || '—'}
        </pre>
      </Card>

      {/* Email composer (generate → preview → send) */}
      {composing && (
        <EmailComposer
          job={job}
          onClose={() => setComposing(false)}
          onSent={() => setJob(j => ({ ...j, tracker_status: 'applied' }))}
        />
      )}
    </>
  )
}
