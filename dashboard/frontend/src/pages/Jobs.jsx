import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { scoreColor } from '../components/charts'
import EmailComposer from '../components/EmailComposer'
import {
  PageHeader, StatCard, ScoreChip,
  CloudFitPill, relativeTime, EmptyState, Loading, inputCls, selectCls,
} from '../components/ui'

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

function AnimatedStatCard({ icon, label, value, tone }) {
  const counted = useCountUp(typeof value === 'number' ? value : 0)
  return <StatCard icon={icon} label={label} value={typeof value === 'number' ? counted : value} tone={tone} />
}

export default function Jobs() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState('all')
  const [scoreMin, setScoreMin] = useState('0')
  const [sortBy, setSortBy] = useState('score')
  const [cloudFit, setCloudFit] = useState('aws_match')
  const [postedWithin, setPostedWithin] = useState('24')
  const [trackerFilter, setTrackerFilter] = useState(new Set()) // empty = all
  const [trackerDropOpen, setTrackerDropOpen] = useState(false)
  const trackerDropRef = useRef(null)
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [searchInput, setSearchInput] = useState(searchParams.get('q') || '')
  const [composing, setComposing] = useState(null)
  const [netNew, setNetNew] = useState(false)

  // Bulk email state
  const [selected, setSelected] = useState(new Set())
  const [bulkStatus, setBulkStatus] = useState(null)   // null | 'sending' | 'done'
  const [bulkResults, setBulkResults] = useState([])
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 })
  const [bulkMinimized, setBulkMinimized] = useState(false)
  const abortBulk = useRef(false)

  const loadJobs = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      score_min: scoreMin, sort: sortBy,
      work_mode: mode === 'all' ? '' : mode, q: search,
      cloud_fit: cloudFit === 'all' ? '' : cloudFit,
      posted_within: postedWithin,
    })
    const data = await fetch('/api/jobs?' + params).then(r => r.json())
    setJobs(data)
    setSelected(new Set())
    setLoading(false)
  }, [scoreMin, sortBy, mode, search, cloudFit, postedWithin])

  useEffect(() => { loadJobs() }, [loadJobs])

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 350)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    const q = searchParams.get('q') || ''
    setSearchInput(q); setSearch(q)
  }, [searchParams])

  useEffect(() => {
    function onMouseDown(e) {
      if (trackerDropRef.current && !trackerDropRef.current.contains(e.target))
        setTrackerDropOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  function toggleTrackerItem(value) {
    setTrackerFilter(prev => {
      const next = new Set(prev)
      next.has(value) ? next.delete(value) : next.add(value)
      return next
    })
  }

  async function saveToTracker(e, job) {
    e.stopPropagation()
    const res = await fetch(`/api/tracker/${job.target_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'saved' }),
    }).then(r => r.json())
    setJobs(js => js.map(j => j.target_id === job.target_id ? { ...j, tracker_status: res.status } : j))
  }

  // Sendable = has recruiter email + no email sent yet
  const sendableJobs = jobs.filter(j => j.recruiter_email && !(j.email_sent_count > 0))
  const sendableIds  = sendableJobs.map(j => j.target_id)
  const allSelected  = sendableIds.length > 0 && sendableIds.every(id => selected.has(id))

  function toggleSelect(targetId, e) {
    e.stopPropagation()
    setSelected(s => {
      const next = new Set(s)
      next.has(targetId) ? next.delete(targetId) : next.add(targetId)
      return next
    })
  }

  function toggleSelectAll(e) {
    e.stopPropagation()
    setSelected(allSelected ? new Set() : new Set(sendableIds))
  }

  async function bulkSend(targetIds) {
    if (!targetIds.length) return
    abortBulk.current = false
    setBulkMinimized(false)
    setBulkStatus('sending')
    setBulkProgress({ current: 0, total: targetIds.length })
    setBulkResults(targetIds.map(id => {
      const j = jobs.find(x => x.target_id === id)
      return { target_id: id, title: j?.title || `Job #${id}`, company: j?.company, status: 'pending' }
    }))

    for (let i = 0; i < targetIds.length; i++) {
      if (abortBulk.current) {
        setBulkResults(prev => prev.map(r => r.status === 'pending' ? { ...r, status: 'skipped' } : r))
        break
      }
      const id = targetIds[i]
      setBulkProgress({ current: i + 1, total: targetIds.length })
      try {
        const genRes = await fetch(`/api/jobs/${id}/generate-email`, { method: 'POST' })
        const genData = await genRes.json()
        if (!genRes.ok) throw new Error(genData.error || 'Generation failed')

        const sendRes = await fetch(`/api/jobs/${id}/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: genData.subject, body: genData.body,
            to_email: genData.to_email, model_used: genData.model_used,
          }),
        })
        const sendData = await sendRes.json()
        if (!sendRes.ok) throw new Error(sendData.error || 'Send failed')

        setBulkResults(prev => prev.map(r => r.target_id === id ? { ...r, status: 'sent' } : r))
      } catch (err) {
        setBulkResults(prev => prev.map(r =>
          r.target_id === id ? { ...r, status: 'failed', error: err.message } : r))
      }
    }

    setBulkStatus('done')
    loadJobs()
  }

  const STATUS_SIMPLE = {
    saved:        { dot: 'bg-info',    label: 'Saved' },
    applied:      { dot: 'bg-accent',  label: 'Applied' },
    interviewing: { dot: 'bg-warning', label: 'Interview' },
    offer:        { dot: 'bg-success', label: 'Offer' },
    rejected:     { dot: 'bg-danger',  label: 'Rejected' },
  }

  const CLOUD_FILTERS = [
    ['all', 'All clouds'],
    ['aws_match', 'AWS match'],
    ['no_cloud_req', 'No cloud req'],
    ['other_cloud_only', 'Other cloud'],
  ]

  const TRACKER_OPTIONS = [
    { value: 'untracked',    label: 'Untracked',    dot: 'bg-faint'    },
    { value: 'saved',        label: 'Saved',        dot: 'bg-info'     },
    { value: 'applied',      label: 'Applied',      dot: 'bg-accent'   },
    { value: 'interviewing', label: 'Interviewing', dot: 'bg-warning'  },
    { value: 'offer',        label: 'Offer',        dot: 'bg-success'  },
    { value: 'rejected',     label: 'Rejected',     dot: 'bg-danger'   },
  ]

  // Client-side filters — tracker multi-select + net-new toggle
  const displayedJobs = jobs.filter(j => {
    if (trackerFilter.size > 0 && !trackerFilter.has(j.tracker_status || 'untracked')) return false
    if (netNew && (j.email_sent_count || 0) > 0) return false
    return true
  })

  const highMatch   = displayedJobs.filter(j => (j.final_ats_score || 0) >= 60).length
  const awsMatch    = displayedJobs.filter(j => j.cloud_fit === 'aws_match').length
  const freshCount  = displayedJobs.filter(j => relativeTime(j.posted_at).fresh).length
  const selectedIds = [...selected]
  const selectedCount = selectedIds.length

  const anyFilterActive = mode !== 'all' || scoreMin !== '0' || cloudFit !== 'aws_match' ||
    postedWithin !== '24' || trackerFilter.size > 0 || sortBy !== 'score' || search || netNew

  function resetFilters() {
    setMode('all'); setScoreMin('0'); setCloudFit('aws_match'); setPostedWithin('24')
    setTrackerFilter(new Set()); setSortBy('score'); setSearchInput(''); setSearch(''); setNetNew(false)
  }

  return (
    <>
      <PageHeader title="Jobs" subtitle="Every job that passed your filters, ranked by ATS score against your resume." />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <div className="fade-up fade-up-1"><AnimatedStatCard icon="query_stats" label="Matched Jobs" value={jobs.length} tone="accent" /></div>
        <div className="fade-up fade-up-2"><AnimatedStatCard icon="check_circle" label="Score ≥ 60" value={highMatch} tone="success" /></div>
        <div className="fade-up fade-up-3"><AnimatedStatCard icon="cloud_done" label="AWS Match" value={awsMatch} tone="warning" /></div>
        <div className="fade-up fade-up-4"><AnimatedStatCard icon="bolt" label="Fresh (≤48h)" value={freshCount} tone="info" /></div>
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className="card rounded-2xl p-4 mb-4 space-y-3 fade-up" style={{ animationDelay: '0.2s' }}>
        {/* Row 1 — Search + Score + Age + actions */}
        <div className="flex items-center gap-2 w-3/4">
          <div className="relative w-[264px] flex-shrink-0">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-faint pointer-events-none">search</span>
            <input value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Search…"
              className={`${inputCls} w-full !pl-9 !py-2 !text-xs`} />
          </div>
          <div className="flex items-center gap-1.5 bg-surface ctrl-border rounded-lg px-3 py-2 w-[260px] flex-shrink-0">
            <span className="text-[11px] text-muted whitespace-nowrap">Score ≥</span>
            <button onClick={() => setScoreMin(s => String(Math.max(0, Number(s) - 5)))}
              className="w-4 h-4 flex items-center justify-center rounded text-muted hover:text-ink hover:bg-surface-2 transition-colors text-sm font-bold leading-none flex-shrink-0">−</button>
            <input type="range" min="0" max="100" step="5" value={scoreMin} onChange={e => setScoreMin(e.target.value)}
              className="flex-1 accent-[rgb(var(--accent))] cursor-pointer" />
            <button onClick={() => setScoreMin(s => String(Math.min(100, Number(s) + 5)))}
              className="w-4 h-4 flex items-center justify-center rounded text-muted hover:text-ink hover:bg-surface-2 transition-colors text-sm font-bold leading-none flex-shrink-0">+</button>
            <span className="text-[11px] font-bold text-ink w-5 text-right tabular-nums">{scoreMin}</span>
          </div>
          <select value={postedWithin} onChange={e => setPostedWithin(e.target.value)} className={`${selectCls} min-w-[120px]`}>
            <option value="0">Any age</option>
            <option value="24">≤ 24h</option>
            <option value="48">≤ 48h</option>
            <option value="168">≤ 7 days</option>
          </select>
          <button onClick={loadJobs}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface ctrl-border text-[11px] font-semibold text-muted hover:text-accent transition-colors whitespace-nowrap">
            <span className="material-symbols-outlined text-[14px]">refresh</span>Refresh
          </button>
          <button onClick={resetFilters} disabled={!anyFilterActive}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface ctrl-border text-[11px] font-semibold transition-colors whitespace-nowrap ${
              anyFilterActive ? 'text-muted hover:text-danger cursor-pointer' : 'text-faint opacity-40 cursor-not-allowed'}`}>
            <span className="material-symbols-outlined text-[14px]">restart_alt</span>Reset
          </button>
        </div>

        {/* Row 2 — Cloud + Mode pill toggles + Net New */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="pill-group">
            {CLOUD_FILTERS.map(([v, lbl]) => (
              <button key={v} onClick={() => setCloudFit(v)}
                className={`px-2.5 py-1 text-[11px] rounded-md font-medium transition-colors ${
                  cloudFit === v ? 'bg-accent text-accent-ink shadow' : 'text-muted hover:text-ink'}`}>
                {lbl}
              </button>
            ))}
          </div>
          <div className="pill-group">
            {['all', 'remote', 'onsite', 'hybrid'].map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2.5 py-1 text-[11px] rounded-md capitalize font-medium transition-colors ${
                  mode === m ? 'bg-accent text-accent-ink shadow' : 'text-muted hover:text-ink'}`}>
                {m}
              </button>
            ))}
          </div>
          <button onClick={() => setNetNew(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
              netNew
                ? 'gradient-accent text-accent-ink shadow glow-accent'
                : 'text-muted hover:text-ink bg-surface-2 border border-line'}`}>
            <span className="material-symbols-outlined text-[13px]">mark_email_unread</span>
            Net New
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ──────────────────────────────────────────────── */}
      {sendableIds.length > 0 && (
        <div className="card rounded-xl px-4 py-2.5 mb-4 flex items-center gap-3 border-l-[3px] border-accent fade-up" style={{ animationDelay: '0.25s' }}>
          <span className="material-symbols-outlined text-[16px] text-accent flex-shrink-0">mark_email_unread</span>
          <span className="text-[12px] text-muted min-w-0">
            {selectedCount > 0
              ? <><span className="font-bold text-ink">{selectedCount}</span> selected &nbsp;·&nbsp;</>
              : null}
            <span className="font-semibold text-ink">{sendableIds.length}</span>
            <span className="text-faint"> unsent in view</span>
          </span>
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            {selectedCount > 0 && (
              <>
                <button onClick={() => bulkSend(selectedIds)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg gradient-accent text-accent-ink text-[11px] font-bold hover:opacity-90 transition-opacity whitespace-nowrap glow-accent">
                  <span className="material-symbols-outlined text-[13px]">send</span>
                  Send Selected ({selectedCount})
                </button>
                <button onClick={() => setSelected(new Set())}
                  className="text-faint hover:text-muted transition-colors text-[11px] px-1">
                  Clear
                </button>
                <span className="w-px h-4 bg-line flex-shrink-0" />
              </>
            )}
            <button onClick={() => bulkSend(sendableIds)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-ink text-[11px] font-bold ctrl-border transition-colors whitespace-nowrap">
              <span className="material-symbols-outlined text-[13px]">send_to_mobile</span>
              Send All ({sendableIds.length})
            </button>
          </div>
        </div>
      )}

      {/* ── Jobs table ──────────────────────────────────────────────────── */}
      <div className="card rounded-2xl overflow-hidden fade-up" style={{ animationDelay: '0.3s' }}>
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left border-collapse">
            <thead className="bg-surface-2 border-b border-line">
              <tr>
                {/* Select-all checkbox */}
                <th className="pl-3 pr-5 py-3 w-12 border-r border-line">
                  {sendableIds.length > 0 && (
                    <label className="flex items-center justify-center cursor-pointer"
                      title={allSelected ? 'Deselect all' : `Select all ${sendableIds.length} unsent`}>
                      <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="sr-only" />
                      <span className={`w-4 h-4 rounded flex items-center justify-center transition-all border-2 ${
                        allSelected
                          ? 'bg-accent border-accent'
                          : sendableIds.some(id => selected.has(id))
                            ? 'bg-accent/30 border-accent'
                            : 'border-line bg-surface-2 hover:border-accent/60'}`}>
                        {allSelected
                          ? <span className="material-symbols-outlined text-[11px] text-accent-ink" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                          : sendableIds.some(id => selected.has(id))
                            ? <span className="w-1.5 h-0.5 bg-accent rounded block" />
                            : null}
                      </span>
                    </label>
                  )}
                </th>
                <th className="pl-4 pr-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Score</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Job</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Cloud</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted cursor-pointer select-none hover:text-accent transition-colors whitespace-nowrap"
                  onClick={() => setSortBy(s => s === 'posted' ? 'score' : 'posted')}>
                  Posted {sortBy === 'posted'
                    ? <span className="material-symbols-outlined text-[12px] align-middle text-accent">arrow_downward</span>
                    : <span className="material-symbols-outlined text-[11px] align-middle opacity-30">unfold_more</span>}
                </th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Exp</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Tech</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Shortlist</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted border-l border-line pl-4">Apply</th>
                <th className="px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-muted">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading ? (
                <tr><td colSpan="10"><Loading /></td></tr>
              ) : !displayedJobs.length ? (
                <tr><td colSpan="10"><EmptyState title="No jobs match these filters" hint="Loosen the score band or clear the search." /></td></tr>
              ) : displayedJobs.map(j => {
                const c          = scoreColor(j.final_ats_score)
                const age        = relativeTime(j.posted_at)
                const skills     = (j.matched_skills || []).slice(0, 3)
                const isSent     = (j.email_sent_count || 0) > 0
                const canSelect  = !!j.recruiter_email && !isSent
                const isSelected = selected.has(j.target_id)

                return (
                  <tr key={j.target_id}
                    className={`hover:bg-surface-2/60 transition-all duration-150 group cursor-pointer ${isSelected ? 'bg-accent/5' : ''}`}
                    onClick={() => navigate(`/ats/${j.target_id}`)}>

                    {/* Checkbox — colored left border anchors here at the true row edge */}
                    <td className="pl-3 pr-5 py-2.5 border-r border-line" style={{ borderLeft: `3px solid ${c}` }} onClick={e => e.stopPropagation()}>
                      {isSent ? (
                        /* Non-interactive green tick for already-sent jobs */
                        <span className="w-4 h-4 rounded flex items-center justify-center bg-success/20 border-2 border-success/50">
                          <span className="material-symbols-outlined text-[11px] text-success" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                        </span>
                      ) : canSelect ? (
                        <label className="flex items-center justify-center cursor-pointer" onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={isSelected} onChange={e => toggleSelect(j.target_id, e)} className="sr-only" />
                          <span className={`w-4 h-4 rounded flex items-center justify-center transition-all border-2 ${
                            isSelected
                              ? 'bg-accent border-accent'
                              : 'border-line bg-surface hover:border-accent/60'}`}>
                            {isSelected && <span className="material-symbols-outlined text-[11px] text-accent-ink" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>}
                          </span>
                        </label>
                      ) : null}
                    </td>

                    {/* Score */}
                    <td className="pl-4 pr-3 py-2.5 score-in">
                      <ScoreChip score={j.final_ats_score} />
                    </td>

                    {/* Job */}
                    <td className="px-3 py-2.5 max-w-[230px]">
                      <p className="font-semibold text-ink text-[13px] truncate group-hover:text-accent transition-colors leading-tight">{j.title || '—'}</p>
                      <p className="text-[10px] text-muted truncate mt-0.5">
                        {j.company || '—'}{j.location ? ` · ${j.location}` : j.work_mode === 'remote' ? ' · Remote' : ''}
                      </p>
                      {skills.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {skills.map(s => (
                            <span key={s} className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium leading-none">{s}</span>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Cloud */}
                    <td className="px-3 py-2.5"><CloudFitPill fit={j.cloud_fit} /></td>

                    {/* Posted */}
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {j.posted_at
                        ? <>
                            <span className={`text-[11px] font-medium ${age.fresh ? 'text-success' : age.stale ? 'text-faint' : 'text-muted'}`}>
                              {age.fresh && <span className="material-symbols-outlined text-[11px] align-middle mr-0.5">bolt</span>}
                              {age.text}
                            </span>
                            <p className="text-[9px] text-faint mt-0.5 tabular-nums">
                              {new Date(j.posted_at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:true })}
                            </p>
                          </>
                        : <span className="text-faint text-[11px]">—</span>}
                    </td>

                    {/* Exp */}
                    <td className="px-3 py-2.5 text-[11px] font-mono text-muted whitespace-nowrap">
                      {j.experience_min != null ? `${j.experience_min}–${j.experience_max ?? '?'}y` : '—'}
                    </td>

                    {/* Tech */}
                    <td className="px-3 py-2.5">
                      {j.technical_skills_score != null
                        ? <div className="w-10">
                            <span className="text-[11px] font-bold" style={{ color: scoreColor(j.technical_skills_score) }}>{j.technical_skills_score}</span>
                            <div className="h-[2px] bg-surface-2 rounded-full mt-1 overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${j.technical_skills_score}%`, background: scoreColor(j.technical_skills_score) }} />
                            </div>
                          </div>
                        : <span className="text-faint text-[11px]">—</span>}
                    </td>

                    {/* Shortlist */}
                    <td className="px-3 py-2.5">
                      {j.shortlist_probability != null
                        ? <div className="w-10">
                            <span className="text-[11px] font-bold" style={{ color: scoreColor(j.shortlist_probability) }}>{j.shortlist_probability}%</span>
                            <div className="h-[2px] bg-surface-2 rounded-full mt-1 overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${j.shortlist_probability}%`, background: scoreColor(j.shortlist_probability) }} />
                            </div>
                          </div>
                        : <span className="text-faint text-[11px]">—</span>}
                    </td>

                    {/* Apply */}
                    <td className="px-4 py-2.5 border-l border-line" onClick={e => e.stopPropagation()}>
                      {j.recruiter_email
                        ? isSent
                          ? <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-success/10 text-success font-semibold whitespace-nowrap">
                              <span className="material-symbols-outlined text-[11px]">mark_email_read</span>Sent
                            </span>
                          : <button onClick={() => setComposing(j)} title={`Email ${j.recruiter_email}`}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent/10 hover:bg-accent text-accent hover:text-accent-ink text-[11px] font-semibold transition-all whitespace-nowrap">
                              <span className="material-symbols-outlined text-[12px]">send</span>Apply
                            </button>
                        : <span className="text-faint text-[11px]">—</span>}
                    </td>

                    {/* Status */}
                    <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                      <div className="flex flex-col gap-1">
                        {/* Tracker status */}
                        {j.tracker_status && STATUS_SIMPLE[j.tracker_status]
                          ? <span className="flex items-center gap-1.5">
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_SIMPLE[j.tracker_status].dot}`} />
                              <span className="text-[11px] text-muted">{STATUS_SIMPLE[j.tracker_status].label}</span>
                            </span>
                          : <button onClick={e => saveToTracker(e, j)} title="Save to tracker"
                              className="text-faint hover:text-accent transition-colors self-start">
                              <span className="material-symbols-outlined text-[17px]">bookmark_add</span>
                            </button>}
                        {/* Email status tag */}
                        {isSent
                          ? <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-success/10 text-success font-semibold whitespace-nowrap w-fit">
                              <span className="material-symbols-outlined text-[10px]">check</span>Email sent
                            </span>
                          : j.recruiter_email
                            ? <span className="text-[9px] px-1.5 py-0.5 rounded bg-warning/10 text-warning font-semibold whitespace-nowrap w-fit">Not sent</span>
                            : <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-2 text-faint font-medium whitespace-nowrap w-fit">No email</span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="bg-surface-2 px-5 py-2.5 border-t border-line flex items-center justify-between">
          <p className="text-muted text-[11px] flex items-center gap-2">
            <span>{displayedJobs.length}{jobs.length !== displayedJobs.length ? ` of ${jobs.length}` : ''} job{displayedJobs.length !== 1 ? 's' : ''}</span>
            {sendableIds.length > 0 && <span className="text-warning font-semibold">· {sendableIds.length} unsent</span>}
            {selectedCount > 0 && <span className="text-accent font-semibold">· {selectedCount} selected</span>}
            {trackerFilter.size > 0 && <span className="text-faint">· filtered by {trackerFilter.size} status{trackerFilter.size > 1 ? 'es' : ''}</span>}
          </p>
          {sortBy === 'posted' && <p className="text-[10px] text-faint">sorted by freshest first · click Posted to toggle</p>}
        </div>
      </div>

      {/* ── Single-job email composer ──────────────────────────────────── */}
      {composing && (
        <EmailComposer job={composing} onClose={() => setComposing(null)}
          onSent={() => setJobs(js => js.map(j =>
            j.target_id === composing.target_id
              ? { ...j, tracker_status: 'applied', email_sent_count: 1 }
              : j))} />
      )}

      {/* ── Bulk send progress modal ───────────────────────────────────── */}
      {bulkStatus && (
        bulkMinimized ? (
          /* Minimized floating bar */
          <div className="fixed bottom-5 right-5 z-50 card rounded-xl px-4 py-3 flex items-center gap-3 shadow-xl border-l-[3px] border-accent min-w-[280px] fade-in">
            {bulkStatus === 'done'
              ? <span className="material-symbols-outlined text-[18px] text-success">task_alt</span>
              : <span className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin flex-shrink-0" />}
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-bold text-ink leading-tight">
                {bulkStatus === 'sending' ? `Sending ${bulkProgress.current} of ${bulkProgress.total}…` : 'Bulk send complete'}
              </p>
              <p className="text-[10px] text-muted mt-0.5">
                <span className="text-success font-semibold">{bulkResults.filter(r => r.status === 'sent').length} sent</span>
                {bulkResults.filter(r => r.status === 'failed').length > 0 && <span className="text-danger font-semibold ml-1.5">{bulkResults.filter(r => r.status === 'failed').length} failed</span>}
                {bulkResults.filter(r => r.status === 'skipped').length > 0 && <span className="text-faint font-semibold ml-1.5">{bulkResults.filter(r => r.status === 'skipped').length} skipped</span>}
              </p>
            </div>
            {bulkStatus === 'sending' && (
              <button onClick={() => { abortBulk.current = true }} title="Stop sending"
                className="text-faint hover:text-danger transition-colors flex-shrink-0">
                <span className="material-symbols-outlined text-[18px]">stop_circle</span>
              </button>
            )}
            <button onClick={() => setBulkMinimized(false)} title="Expand"
              className="text-faint hover:text-ink transition-colors flex-shrink-0">
              <span className="material-symbols-outlined text-[18px]">open_in_full</span>
            </button>
            {bulkStatus === 'done' && (
              <button onClick={() => { setBulkStatus(null); setBulkResults([]); setSelected(new Set()) }}
                title="Dismiss" className="text-faint hover:text-ink transition-colors flex-shrink-0">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>
        ) : (
          /* Full modal */
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 fade-in">
            <div className="card rounded-2xl w-full max-w-[460px] max-h-[80vh] flex flex-col overflow-hidden slide-right">

              {/* Header */}
              <div className="px-6 pt-5 pb-4 border-b border-line flex items-center gap-3">
                {bulkStatus === 'done'
                  ? <span className="material-symbols-outlined text-[22px] text-success">task_alt</span>
                  : <span className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin flex-shrink-0" />}
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold text-ink text-sm leading-tight">
                    {bulkStatus === 'sending' ? `Sending ${bulkProgress.current} of ${bulkProgress.total}…` : 'Bulk send complete'}
                  </h3>
                  {bulkStatus === 'done' && (
                    <p className="text-[11px] text-muted mt-0.5">
                      <span className="text-success font-semibold">{bulkResults.filter(r => r.status === 'sent').length} sent</span>
                      {bulkResults.filter(r => r.status === 'failed').length > 0 && <span className="text-danger font-semibold ml-2">{bulkResults.filter(r => r.status === 'failed').length} failed</span>}
                      {bulkResults.filter(r => r.status === 'skipped').length > 0 && <span className="text-faint font-semibold ml-2">{bulkResults.filter(r => r.status === 'skipped').length} skipped</span>}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 ml-auto flex-shrink-0">
                  {bulkStatus === 'sending' && (
                    <>
                      <span className="text-[11px] text-muted tabular-nums font-mono mr-2">
                        {Math.round(bulkProgress.current / bulkProgress.total * 100)}%
                      </span>
                      <button onClick={() => { abortBulk.current = true }} title="Stop sending"
                        className="p-1 rounded hover:bg-danger/10 text-faint hover:text-danger transition-colors">
                        <span className="material-symbols-outlined text-[18px]">stop_circle</span>
                      </button>
                    </>
                  )}
                  <button onClick={() => setBulkMinimized(true)} title="Minimise"
                    className="p-1 rounded hover:bg-surface-2 text-faint hover:text-ink transition-colors">
                    <span className="material-symbols-outlined text-[18px]">remove</span>
                  </button>
                </div>
              </div>

              {/* Progress bar */}
              {bulkStatus === 'sending' && (
                <div className="h-1 bg-surface-2 flex-shrink-0">
                  <div className="h-full gradient-accent transition-all duration-500 rounded-r"
                    style={{ width: `${bulkProgress.current / bulkProgress.total * 100}%` }} />
                </div>
              )}

              {/* Job list */}
              <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
                {bulkResults.map(r => (
                  <div key={r.target_id}
                    className={`flex items-start gap-2.5 p-2.5 rounded-lg transition-colors ${
                      r.status === 'sent'    ? 'bg-success/5 border border-success/15'
                    : r.status === 'failed'  ? 'bg-danger/5 border border-danger/15'
                    : r.status === 'skipped' ? 'bg-surface-2/30 border border-line/30 opacity-50'
                    : 'bg-surface-2/50 border border-line/50'}`}>
                    {r.status === 'sent'
                      ? <span className="material-symbols-outlined text-[16px] text-success mt-0.5 flex-shrink-0">check_circle</span>
                      : r.status === 'failed'
                      ? <span className="material-symbols-outlined text-[16px] text-danger mt-0.5 flex-shrink-0">error</span>
                      : r.status === 'skipped'
                      ? <span className="material-symbols-outlined text-[16px] text-faint mt-0.5 flex-shrink-0">skip_next</span>
                      : <span className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin mt-0.5 flex-shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-semibold text-ink truncate leading-tight">{r.title}</p>
                      {r.company && <p className="text-[10px] text-muted truncate">{r.company}</p>}
                      {r.error && <p className="text-[10px] text-danger mt-0.5 break-words">{r.error}</p>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Footer */}
              {bulkStatus === 'done' && (
                <div className="px-6 py-4 border-t border-line">
                  <button onClick={() => { setBulkStatus(null); setBulkResults([]); setSelected(new Set()) }}
                    className="w-full py-2.5 rounded-xl gradient-accent text-accent-ink text-sm font-bold hover:opacity-90 transition-opacity glow-accent">
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      )}
    </>
  )
}
