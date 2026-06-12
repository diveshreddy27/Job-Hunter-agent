import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ScoreRing, scoreColor, GrowBar } from '../components/charts'
import { Card, TRACKER_META, EmptyState, Loading, selectCls } from '../components/ui'

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

  // Email modal state
  const [email, setEmail] = useState({ status: 'idle', subject: '', body: '', toEmail: '', modelUsed: '', error: '' })
  const bodyRef = useRef(null)

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

  async function generateEmail() {
    setEmail({ status: 'generating', subject: '', body: '', toEmail: '', modelUsed: '', error: '' })
    try {
      const r = await fetch(`/api/jobs/${id}/generate-email`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Generation failed')
      setEmail({ status: 'ready', subject: d.subject, body: d.body, toEmail: d.to_email, modelUsed: d.model_used || '', error: '' })
    } catch (e) {
      setEmail(prev => ({ ...prev, status: 'error', error: e.message }))
    }
  }

  async function sendEmail() {
    setEmail(prev => ({ ...prev, status: 'sending', error: '' }))
    try {
      const r = await fetch(`/api/jobs/${id}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: email.subject, body: email.body, to_email: email.toEmail, model_used: email.modelUsed }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Send failed')
      setEmail(prev => ({ ...prev, status: 'sent' }))
      setJob(j => ({ ...j, tracker_status: 'applied' }))
    } catch (e) {
      setEmail(prev => ({ ...prev, status: 'ready', error: e.message }))
    }
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
              onClick={generateEmail}
              disabled={email.status === 'generating'}
              className="bg-accent text-accent-ink px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide hover:brightness-110 flex items-center gap-2 shadow-lg shadow-accent/25 disabled:opacity-60 disabled:cursor-wait">
              <span className="material-symbols-outlined text-[18px]">
                {email.status === 'generating' ? 'sync' : 'send'}
              </span>
              {email.status === 'generating' ? 'Generating…' : 'Send Email'}
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

      {/* Raw post */}
      <Card title="Full Job Post" icon="description">
        <pre className="text-xs font-mono text-muted whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto custom-scrollbar">
          {job.post_content || '—'}
        </pre>
      </Card>

      {/* Email modal */}
      {(email.status === 'ready' || email.status === 'sending' || email.status === 'sent' || email.status === 'error') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}>
          <div className="bg-[rgb(var(--bg))] border border-[rgb(var(--line))] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[rgb(var(--line))]">
              <div>
                <h3 className="font-bold text-ink text-base">Send Email to Recruiter</h3>
                <p className="text-xs text-muted mt-0.5">To: {email.toEmail}</p>
              </div>
              <button onClick={() => setEmail({ status: 'idle', subject: '', body: '', toEmail: '', modelUsed: '', error: '' })}
                className="text-muted hover:text-ink transition-colors">
                <span className="material-symbols-outlined text-[22px]">close</span>
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {email.status === 'sent' ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <span className="material-symbols-outlined text-[48px] text-success">check_circle</span>
                  <p className="font-semibold text-ink text-lg">Email sent!</p>
                  <p className="text-muted text-sm">Tracker status auto-updated to Applied.</p>
                </div>
              ) : (
                <>
                  {email.error && (
                    <div className="bg-danger/10 text-danger text-xs rounded-xl px-4 py-3 flex items-center gap-2">
                      <span className="material-symbols-outlined text-[16px]">error</span>{email.error}
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-semibold text-muted mb-1.5 uppercase tracking-wider">Subject</label>
                    <input
                      type="text"
                      value={email.subject}
                      onChange={e => setEmail(p => ({ ...p, subject: e.target.value }))}
                      className="w-full rounded-xl border border-[rgb(var(--line))] bg-[rgb(var(--surface))] text-ink text-sm px-4 py-2.5 focus:outline-none focus:border-accent transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-muted mb-1.5 uppercase tracking-wider">Body</label>
                    <textarea
                      ref={bodyRef}
                      value={email.body}
                      onChange={e => setEmail(p => ({ ...p, body: e.target.value }))}
                      rows={14}
                      className="w-full rounded-xl border border-[rgb(var(--line))] bg-[rgb(var(--surface))] text-ink text-sm px-4 py-2.5 font-mono leading-relaxed focus:outline-none focus:border-accent transition-colors resize-none custom-scrollbar"
                    />
                  </div>
                  {email.modelUsed && (
                    <p className="text-[11px] text-faint">Generated by {email.modelUsed}</p>
                  )}
                </>
              )}
            </div>

            {/* Modal footer */}
            {email.status !== 'sent' && (
              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[rgb(var(--line))]">
                <button onClick={() => setEmail({ status: 'idle', subject: '', body: '', toEmail: '', modelUsed: '', error: '' })}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-muted hover:text-ink border border-[rgb(var(--line))] transition-colors">
                  Cancel
                </button>
                <button onClick={generateEmail}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-muted hover:text-accent border border-[rgb(var(--line))] transition-colors flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[15px]">refresh</span>Regenerate
                </button>
                <button onClick={sendEmail}
                  disabled={email.status === 'sending' || !email.subject || !email.body}
                  className="bg-accent text-accent-ink px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wide hover:brightness-110 flex items-center gap-2 disabled:opacity-60 disabled:cursor-wait shadow-lg shadow-accent/25">
                  <span className="material-symbols-outlined text-[16px]">
                    {email.status === 'sending' ? 'sync' : 'send'}
                  </span>
                  {email.status === 'sending' ? 'Sending…' : 'Send'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
