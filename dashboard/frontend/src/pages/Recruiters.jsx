import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { scoreColor } from '../components/charts'
import { PageHeader, StatCard, EmptyState, Loading, inputCls, relativeTime } from '../components/ui'

/* Count from 0 → target over `duration` ms using an ease-out cubic. */
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

/* Stagger delay: grows linearly up to a cap so late cards don't wait forever. */
function staggerDelay(i, step = 0.055, cap = 0.48) {
  return `${Math.min(i * step, cap)}s`
}

/* ── Recruiter drawer ─────────────────────────────────────────────────── */
function RecruiterDrawer({ recruiter, onClose }) {
  const navigate = useNavigate()
  const [posts, setPosts] = useState(null)

  useEffect(() => {
    if (!recruiter) return
    setPosts(null)
    fetch(`/api/recruiters/${encodeURIComponent(recruiter.recruiter_email)}/posts`)
      .then(r => r.json())
      .then(setPosts)
  }, [recruiter])

  if (!recruiter) return null

  const initials = (recruiter.recruiter_name || recruiter.recruiter_email || '?').slice(0, 2).toUpperCase()

  const statItems = [
    { label: 'Posts',      raw: recruiter.post_count,                 color: null },
    { label: 'Best score', raw: recruiter.best_score,                  color: recruiter.best_score  != null ? scoreColor(recruiter.best_score)  : null },
    { label: 'Avg score',  raw: recruiter.avg_score != null ? Math.round(recruiter.avg_score) : null, color: recruiter.avg_score != null ? scoreColor(recruiter.avg_score) : null },
    { label: 'Scored',     raw: recruiter.scored_count,               color: null },
  ]

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 fade-in" onClick={onClose} />

      {/* Drawer */}
      <div key={recruiter.recruiter_email}
        className="fixed right-0 top-0 h-full w-full max-w-[580px] z-50 flex flex-col border-l border-line shadow-2xl slide-right"
        style={{ background: 'rgb(var(--bg))' }}>

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-line flex items-start gap-4 flex-shrink-0 fade-up">
          <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-[15px] shrink-0 avatar-glow"
            style={{ background: 'linear-gradient(135deg, rgb(var(--accent)/0.2), rgb(var(--accent-2)/0.15))', color: 'rgb(var(--accent))' }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-ink text-[15px] leading-tight truncate">{recruiter.recruiter_name || '—'}</h2>
            {recruiter.recruiter_designation && (
              <p className="text-[12px] text-muted truncate mt-0.5">{recruiter.recruiter_designation}</p>
            )}
            {recruiter.recruiter_current_company && (
              <p className="text-[11px] text-faint truncate">{recruiter.recruiter_current_company}</p>
            )}
            <a href={`mailto:${recruiter.recruiter_email}`}
              className="text-[11px] font-mono text-accent hover:underline mt-1 block truncate">
              {recruiter.recruiter_email}
            </a>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-2 text-faint hover:text-ink transition-colors flex-shrink-0">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Stats strip — count-up numbers */}
        <div className="flex items-center border-b border-line divide-x divide-line flex-shrink-0 fade-up fade-up-1">
          {statItems.map(({ label, raw, color }) => (
            <StatStrip key={label} label={label} raw={raw} color={color} />
          ))}
        </div>

        {/* Post list */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
          {!posts ? (
            <div className="flex flex-col gap-3">
              {[1,2,3].map(i => (
                <div key={i} className="skeleton rounded-xl h-28" />
              ))}
            </div>
          ) : !posts.length ? (
            <EmptyState title="No posts found" />
          ) : posts.map((p, i) => (
            <PostCard key={i} post={p} index={i} onNavigate={navigate} />
          ))}
        </div>
      </div>
    </>
  )
}

/* Animated stat cell inside drawer */
function StatStrip({ label, raw, color }) {
  const counted = useCountUp(raw ?? 0)
  return (
    <div className="flex-1 py-3 text-center">
      <p className="text-[17px] font-bold tabular-nums score-in"
        style={color ? { color } : { color: 'rgb(var(--ink))' }}>
        {raw != null ? counted : '—'}
      </p>
      <p className="text-[10px] text-faint mt-0.5">{label}</p>
    </div>
  )
}

/* Individual post card inside drawer */
function PostCard({ post: p, index: i, onNavigate }) {
  const age    = relativeTime(p.posted_at)
  const skills = (p.skills || '').split(',').map(s => s.trim()).filter(Boolean)
  const isScored = p.final_ats_score != null

  return (
    <div
      className={`card rounded-xl p-4 space-y-3 fade-up ${p.target_job_id ? 'card-hover cursor-pointer' : ''}`}
      style={{ animationDelay: staggerDelay(i, 0.06, 0.55) }}
      onClick={() => p.target_job_id && onNavigate(`/ats/${p.target_job_id}`)}>

      {/* Title + score */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-ink text-[13px] leading-tight">{p.title || '—'}</p>
          {p.company && <p className="text-[11px] text-muted mt-0.5">{p.company}</p>}
        </div>
        {isScored ? (
          <span className="text-[13px] font-bold shrink-0 tabular-nums score-in"
            style={{ color: scoreColor(p.final_ats_score) }}>
            {p.final_ats_score}
          </span>
        ) : p.target_job_id ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning font-semibold shrink-0 whitespace-nowrap">Unscored</span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-faint font-medium shrink-0 whitespace-nowrap">Filtered out</span>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        {(p.location_city || p.location_state || p.location_country) && (
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[12px]">location_on</span>
            {[p.location_city, p.location_state, p.location_country].filter(Boolean).join(', ')}
          </span>
        )}
        {p.work_mode && (
          <span className="flex items-center gap-1 capitalize">
            <span className="material-symbols-outlined text-[12px]">work</span>{p.work_mode}
          </span>
        )}
        {(p.experience_min != null || p.experience_max != null) && (
          <span className="flex items-center gap-1 font-mono">
            <span className="material-symbols-outlined text-[12px]">timeline</span>
            {p.experience_min ?? '?'}–{p.experience_max ?? '?'}y
          </span>
        )}
        {p.posted_at && (
          <span className={`flex items-center gap-1 ${age.fresh ? 'text-success' : age.stale ? 'text-faint' : 'text-muted'}`}>
            <span className="material-symbols-outlined text-[12px]">schedule</span>{age.text}
          </span>
        )}
      </div>

      {/* Cloud */}
      {p.cloud_fit && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="material-symbols-outlined text-[12px] text-muted">cloud</span>
          <span className={`font-semibold ${
            p.cloud_fit === 'aws_match'     ? 'text-warning' :
            p.cloud_fit === 'no_cloud_req'  ? 'text-success' : 'text-muted'}`}>
            {p.cloud_fit === 'aws_match' ? 'AWS match' : p.cloud_fit === 'no_cloud_req' ? 'No cloud req' : 'Other cloud'}
          </span>
          {p.clouds_required && <span className="text-faint">· {p.clouds_required}</span>}
        </div>
      )}

      {/* Skills chips — pop in with stagger */}
      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {skills.slice(0, 8).map((s, si) => (
            <span key={si} className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium pop-in"
              style={{ animationDelay: `${si * 0.035}s` }}>
              {s}
            </span>
          ))}
          {skills.length > 8 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-2 text-faint font-medium">{`+${skills.length - 8}`}</span>
          )}
        </div>
      )}

      {/* Email hints */}
      {(p.email_subject_format || p.email_required_fields) && (
        <div className="border-t border-line pt-2.5 space-y-1.5">
          {p.email_subject_format && (
            <div className="flex items-start gap-2">
              <span className="text-[10px] font-semibold text-faint uppercase tracking-wide shrink-0 mt-0.5">Subject</span>
              <span className="text-[11px] text-muted font-mono leading-snug">{p.email_subject_format}</span>
            </div>
          )}
          {p.email_required_fields && (
            <div className="flex items-start gap-2">
              <span className="text-[10px] font-semibold text-faint uppercase tracking-wide shrink-0 mt-0.5">Needs</span>
              <div className="flex flex-wrap gap-1">
                {p.email_required_fields.split(',').map(f => f.trim()).filter(Boolean).map((f, fi) => (
                  <span key={fi} className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium pop-in"
                    style={{ animationDelay: `${fi * 0.04}s` }}>{f}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-faint">
          {p.extracted_by === 'gemini' ? 'Gemini' : p.extracted_by === 'local_ner' ? 'Local NER' : p.extracted_by || '—'}
        </span>
        <div className="flex items-center gap-3">
          {p.post_url && (
            <a href={p.post_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
              className="text-[10px] text-faint hover:text-accent transition-colors flex items-center gap-0.5">
              <span className="material-symbols-outlined text-[12px]">open_in_new</span>LinkedIn
            </a>
          )}
          {p.target_job_id && (
            <span className="text-[10px] text-accent font-semibold flex items-center gap-0.5">
              View detail <span className="material-symbols-outlined text-[12px]">arrow_forward</span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Animated stat card for page header ─────────────────────────────── */
function AnimatedStatCard({ icon, label, value, tone }) {
  const counted = useCountUp(typeof value === 'number' ? value : 0)
  return <StatCard icon={icon} label={label} value={typeof value === 'number' ? counted : value} tone={tone} />
}

/* ── Main page ────────────────────────────────────────────────────────── */
export default function Recruiters() {
  const [allData, setAllData]   = useState(null)
  const [search, setSearch]     = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    fetch('/api/recruiters').then(r => r.json()).then(setAllData)
  }, [])

  const openDrawer  = useCallback((r) => setSelected(r), [])
  const closeDrawer = useCallback(() => setSelected(null), [])

  if (!allData) return <Loading />

  const q = search.toLowerCase()
  const filtered = q
    ? allData.filter(r =>
        (r.recruiter_name || '').toLowerCase().includes(q) ||
        (r.recruiter_email || '').toLowerCase().includes(q) ||
        (r.recruiter_current_company || '').toLowerCase().includes(q) ||
        (r.companies || '').toLowerCase().includes(q))
    : allData

  const uniqueCompanies = new Set()
  allData.forEach(r => (r.companies || '').split(',').forEach(c => { if (c.trim()) uniqueCompanies.add(c.trim()) }))
  const scores   = allData.filter(r => r.avg_score).map(r => r.avg_score)
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0

  return (
    <>
      <PageHeader title="Recruiter Directory" subtitle="Click a card to see all their posts with extracted fields.">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[15px] text-faint pointer-events-none">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search name, email, company…"
            className={`${inputCls} !pl-9 w-64`} />
        </div>
      </PageHeader>

      {/* Stat cards with count-up */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <div className="fade-up fade-up-1"><AnimatedStatCard icon="contact_page"    label="Total Recruiters"  value={allData.length}                                tone="accent"  /></div>
        <div className="fade-up fade-up-2"><AnimatedStatCard icon="mark_email_read" label="With Email"        value={allData.filter(r => r.recruiter_email).length} tone="success" /></div>
        <div className="fade-up fade-up-3"><AnimatedStatCard icon="business"        label="Unique Companies"  value={uniqueCompanies.size}                          tone="warning" /></div>
        <div className="fade-up fade-up-4"><AnimatedStatCard icon="analytics"       label="Avg Score Posted"  value={avgScore ? `${avgScore}/100` : '—'}            tone="info"    /></div>
      </div>

      {!filtered.length ? (
        <EmptyState title="No recruiters found" hint="Try a different search term." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((r, idx) => {
            const initials  = (r.recruiter_name || r.recruiter_email || '?').slice(0, 2).toUpperCase()
            const hiringFor = (r.companies || '').split(',').map(c => c.trim()).filter(Boolean)
            const isOpen    = selected?.recruiter_email === r.recruiter_email

            return (
              <div key={idx}
                onClick={() => openDrawer(r)}
                className={`card rounded-2xl p-5 flex flex-col gap-4 cursor-pointer card-hover group fade-up
                  ${isOpen ? 'ring-2 ring-[rgb(var(--accent))] ring-offset-2 ring-offset-[rgb(var(--bg))]' : ''}`}
                style={{ animationDelay: staggerDelay(idx) }}>

                {/* Top — avatar + identity + email button */}
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-[13px] shrink-0 mt-0.5 avatar-glow transition-transform duration-300 group-hover:scale-110"
                    style={{ background: 'linear-gradient(135deg, rgb(var(--accent)/0.18), rgb(var(--accent-2)/0.12))', color: 'rgb(var(--accent))' }}>
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-ink text-[14px] leading-tight truncate group-hover:text-accent transition-colors">{r.recruiter_name || '—'}</p>
                    {r.recruiter_designation && <p className="text-[11px] text-muted truncate mt-0.5">{r.recruiter_designation}</p>}
                    {r.recruiter_current_company && <p className="text-[11px] text-faint truncate">{r.recruiter_current_company}</p>}
                  </div>
                  <a href={`mailto:${r.recruiter_email}`}
                    onClick={e => e.stopPropagation()}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-accent/10 hover:bg-accent text-accent hover:text-accent-ink text-[11px] font-semibold transition-all whitespace-nowrap shrink-0">
                    <span className="material-symbols-outlined text-[13px]">mail</span>Email
                  </a>
                </div>

                {/* Email */}
                <p className="text-[11px] font-mono text-accent truncate -mt-2">{r.recruiter_email}</p>

                {/* Stats */}
                <div className="flex items-center gap-0 py-3 border-y border-line">
                  {[
                    { label: 'Posts',      val: r.post_count, color: null },
                    { label: 'Best score', val: r.best_score, color: r.best_score  != null ? scoreColor(r.best_score)  : null },
                    { label: 'Avg score',  val: r.avg_score  != null ? Math.round(r.avg_score) : null, color: r.avg_score != null ? scoreColor(r.avg_score) : null },
                  ].map(({ label, val, color }, si) => (
                    <div key={label} className={`text-center flex-1 ${si > 0 ? 'border-l border-line' : ''}`}>
                      <p className="text-[18px] font-bold tabular-nums" style={color ? { color } : { color: 'rgb(var(--ink))' }}>
                        {val ?? '—'}
                      </p>
                      <p className="text-[10px] text-faint mt-0.5">{label}</p>
                    </div>
                  ))}
                </div>

                {/* Hiring for chips */}
                {hiringFor.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-faint mb-1.5">Hiring for</p>
                    <div className="flex flex-wrap gap-1.5">
                      {hiringFor.slice(0, 4).map((c, ci) => (
                        <span key={ci} className="text-[10px] px-2 py-0.5 rounded-full bg-surface-2 text-muted font-medium truncate max-w-[160px] pop-in"
                          style={{ animationDelay: staggerDelay(idx + ci, 0.04, 0.4) }}>
                          {c}
                        </span>
                      ))}
                      {hiringFor.length > 4 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-2 text-faint font-medium">+{hiringFor.length - 4}</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between mt-auto">
                  <p className="text-[10px] text-faint">Last seen · {r.last_seen ? r.last_seen.slice(0, 10) : '—'}</p>
                  <span className="text-[10px] text-accent font-semibold flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    {r.post_count} post{r.post_count !== 1 ? 's' : ''} <span className="material-symbols-outlined text-[12px]">chevron_right</span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-muted text-[11px] mt-4 fade-up" style={{ animationDelay: '0.2s' }}>
        Showing {filtered.length} recruiter{filtered.length !== 1 ? 's' : ''}
        {q && <span className="text-faint"> for "{search}"</span>}
      </p>

      <RecruiterDrawer recruiter={selected} onClose={closeDrawer} />
    </>
  )
}
