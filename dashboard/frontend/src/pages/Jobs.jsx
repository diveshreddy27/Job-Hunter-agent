import { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { scoreColor, GrowBar } from '../components/charts'
import EmailComposer from '../components/EmailComposer'
import {
  PageHeader, StatCard, ScoreChip, ModePill, TrackerBadge,
  CloudFitPill, CloudChips, relativeTime, EmptyState, Loading, inputCls, selectCls,
} from '../components/ui'

export default function Jobs() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState('all')
  const [scoreMin, setScoreMin] = useState('0')
  const [sortBy, setSortBy] = useState('score')
  const [cloudFit, setCloudFit] = useState('all')
  const [postedWithin, setPostedWithin] = useState('0')
  const [hasEmail, setHasEmail] = useState(false)
  const [tracker, setTracker] = useState('all')
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [searchInput, setSearchInput] = useState(searchParams.get('q') || '')
  const [composing, setComposing] = useState(null)   // job whose email is being composed

  const loadJobs = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      score_min: scoreMin, sort: sortBy,
      work_mode: mode === 'all' ? '' : mode, q: search,
      cloud_fit: cloudFit === 'all' ? '' : cloudFit,
      posted_within: postedWithin,
      has_email: hasEmail ? '1' : '',
      tracker: tracker === 'all' ? '' : tracker,
    })
    const data = await fetch('/api/jobs?' + params).then(r => r.json())
    setJobs(data)
    setLoading(false)
  }, [scoreMin, sortBy, mode, search, cloudFit, postedWithin, hasEmail, tracker])

  useEffect(() => { loadJobs() }, [loadJobs])

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 350)
    return () => clearTimeout(t)
  }, [searchInput])

  // Sync search box when the topbar navigates here with ?q=
  useEffect(() => {
    const q = searchParams.get('q') || ''
    setSearchInput(q); setSearch(q)
  }, [searchParams])

  async function saveToTracker(e, job) {
    e.stopPropagation()
    const res = await fetch(`/api/tracker/${job.target_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'saved' }),
    }).then(r => r.json())
    setJobs(js => js.map(j => j.target_id === job.target_id ? { ...j, tracker_status: res.status } : j))
  }

  const highMatch = jobs.filter(j => (j.final_ats_score || 0) >= 60).length
  const awsMatch = jobs.filter(j => j.cloud_fit === 'aws_match').length
  const freshCount = jobs.filter(j => relativeTime(j.posted_at).fresh).length

  const CLOUD_FILTERS = [
    ['all', 'All clouds'],
    ['aws_match', 'AWS match'],
    ['no_cloud_req', 'No cloud req'],
    ['other_cloud_only', 'Other cloud'],
  ]

  const anyFilterActive = mode !== 'all' || scoreMin !== '0' || cloudFit !== 'all' ||
    postedWithin !== '0' || hasEmail || tracker !== 'all' || search

  function resetFilters() {
    setMode('all'); setScoreMin('0'); setCloudFit('all'); setPostedWithin('0')
    setHasEmail(false); setTracker('all'); setSearchInput(''); setSearch('')
  }

  return (
    <>
      <PageHeader title="Jobs" subtitle="Every job that passed your filters, ranked by ATS score against your resume." />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <StatCard icon="query_stats" label="Matched Jobs" value={jobs.length} tone="accent" />
        <StatCard icon="check_circle" label="Score ≥ 60" value={highMatch} tone="success" />
        <StatCard icon="cloud_done" label="AWS Match" value={awsMatch} tone="warning" />
        <StatCard icon="bolt" label="Fresh (≤48h)" value={freshCount} tone="info" />
      </div>

      {/* Filters */}
      <div className="card rounded-2xl p-4 mb-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-muted">
            <span className="material-symbols-outlined text-[20px]">filter_list</span>
            <span className="text-xs font-semibold">Filters</span>
          </div>
          <select value={scoreMin} onChange={e => setScoreMin(e.target.value)} className={selectCls}>
            <option value="0">All scores</option>
            <option value="80">Elite (80+)</option>
            <option value="60">Strong (60+)</option>
            <option value="40">Developing (40+)</option>
          </select>
          <select value={postedWithin} onChange={e => setPostedWithin(e.target.value)} className={selectCls}>
            <option value="0">Any age</option>
            <option value="24">Posted ≤ 24h</option>
            <option value="48">Posted ≤ 48h</option>
            <option value="168">Posted ≤ 7d</option>
          </select>
          <select value={tracker} onChange={e => setTracker(e.target.value)} className={selectCls}>
            <option value="all">Any status</option>
            <option value="untracked">Untracked</option>
            <option value="saved">Saved</option>
            <option value="applied">Applied</option>
            <option value="interviewing">Interviewing</option>
            <option value="offer">Offer</option>
            <option value="rejected">Rejected</option>
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className={selectCls}>
            <option value="score">Sort: ATS score</option>
            <option value="interview">Sort: Interview %</option>
            <option value="posted">Sort: Freshest</option>
            <option value="date">Sort: Newest scrape</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none ml-auto">
            <input type="checkbox" checked={hasEmail} onChange={e => setHasEmail(e.target.checked)}
              className="accent-[rgb(var(--accent))] w-3.5 h-3.5" />
            Has recruiter email
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Cloud fit pill group */}
          <div className="flex bg-surface-2 p-1 rounded-lg gap-1">
            {CLOUD_FILTERS.map(([v, lbl]) => (
              <button key={v} onClick={() => setCloudFit(v)}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                  cloudFit === v ? 'bg-accent text-accent-ink shadow' : 'text-muted hover:text-ink'}`}>
                {lbl}
              </button>
            ))}
          </div>
          {/* Work mode pill group */}
          <div className="flex bg-surface-2 p-1 rounded-lg gap-1">
            {['all', 'remote', 'onsite', 'hybrid'].map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-1 text-xs rounded-md capitalize font-medium transition-colors ${
                  mode === m ? 'bg-accent text-accent-ink shadow' : 'text-muted hover:text-ink'}`}>
                {m}
              </button>
            ))}
          </div>
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search title, company, skills…"
            className={`${inputCls} ml-auto w-60 !py-1.5 !text-xs`}
          />
          {anyFilterActive && (
            <button onClick={resetFilters}
              className="text-xs font-semibold text-muted hover:text-danger flex items-center gap-1 transition-colors">
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>Reset
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left border-collapse">
            <thead className="bg-surface-2 border-b border-line">
              <tr>
                {['Score', 'Job', 'Company', 'Cloud', 'Posted', 'Mode', 'Exp', 'Interview', 'Status', ''].map((h, i) => (
                  <th key={i} className="px-5 py-3.5 text-[11px] font-bold uppercase tracking-wider text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {loading ? (
                <tr><td colSpan="10"><Loading /></td></tr>
              ) : !jobs.length ? (
                <tr><td colSpan="10"><EmptyState title="No jobs match these filters" hint="Loosen the score band or clear the search." /></td></tr>
              ) : jobs.map((j, i) => {
                const c = scoreColor(j.final_ats_score)
                const age = relativeTime(j.posted_at)
                return (
                  <tr key={j.target_id}
                    className="hover:bg-surface-2 transition-colors group cursor-pointer"
                    onClick={() => navigate(`/ats/${j.target_id}`)}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <span className="text-faint text-xs font-mono w-5">{i + 1}</span>
                        <ScoreChip score={j.final_ats_score} />
                        <div className="w-14 h-1.5 bg-surface-2 rounded-full overflow-hidden hidden lg:block">
                          <GrowBar pct={j.final_ats_score || 0} color={c} />
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 max-w-[260px]">
                      <p className="font-semibold text-ink text-sm truncate group-hover:text-accent transition-colors">{j.title || '—'}</p>
                      <p className="text-[11px] text-faint truncate">{(j.matched_skills || []).slice(0, 3).join(' · ')}</p>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-muted max-w-[160px] truncate">{j.company || '—'}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1 items-start">
                        <CloudFitPill fit={j.cloud_fit} />
                        <CloudChips clouds={j.clouds_list} />
                      </div>
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {j.posted_at
                        ? <span className={`text-xs font-medium ${age.fresh ? 'text-success' : age.stale ? 'text-faint' : 'text-muted'}`}>
                            {age.fresh && <span className="material-symbols-outlined text-[13px] align-middle mr-0.5">bolt</span>}
                            {age.text}
                          </span>
                        : <span className="text-faint text-xs">—</span>}
                    </td>
                    <td className="px-5 py-3.5"><ModePill mode={j.work_mode} /></td>
                    <td className="px-5 py-3.5 text-xs font-mono text-muted whitespace-nowrap">
                      {j.experience_min != null ? `${j.experience_min}–${j.experience_max ?? '?'}y` : '—'}
                    </td>
                    <td className="px-5 py-3.5 font-bold text-sm" style={{ color: c }}>
                      {j.interview_probability != null ? j.interview_probability + '%' : '—'}
                    </td>
                    <td className="px-5 py-3.5">
                      {j.tracker_status
                        ? <TrackerBadge status={j.tracker_status} />
                        : <button onClick={e => saveToTracker(e, j)}
                            title="Save to tracker"
                            className="text-faint hover:text-accent transition-colors">
                            <span className="material-symbols-outlined text-[20px]">bookmark_add</span>
                          </button>}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        {j.recruiter_email && (
                          <button onClick={e => { e.stopPropagation(); setComposing(j) }}
                            title={`Email ${j.recruiter_email}`}
                            className="text-faint hover:text-accent transition-colors">
                            <span className="material-symbols-outlined text-[19px]">send</span>
                          </button>
                        )}
                        <Link to={`/ats/${j.target_id}`} onClick={e => e.stopPropagation()}
                          className="text-faint hover:text-accent transition-colors">
                          <span className="material-symbols-outlined text-[19px]">open_in_new</span>
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="bg-surface-2 px-6 py-3 border-t border-line">
          <p className="text-muted text-xs">Showing {jobs.length} job{jobs.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {composing && (
        <EmailComposer
          job={composing}
          onClose={() => setComposing(null)}
          onSent={() => setJobs(js => js.map(j =>
            j.target_id === composing.target_id ? { ...j, tracker_status: 'applied' } : j))}
        />
      )}
    </>
  )
}
