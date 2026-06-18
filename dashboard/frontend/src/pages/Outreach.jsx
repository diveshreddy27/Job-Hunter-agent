import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { scoreColor } from '../components/charts'
import { PageHeader, StatCard, EmptyState, Loading, inputCls } from '../components/ui'

const TRACKER_STATUSES = ['applied', 'assessment', 'interviewing', 'offer', 'rejected']

const TRACKER_STYLE = {
  applied:      { cls: 'bg-accent/10 text-accent',     label: 'Applied'      },
  assessment:   { cls: 'bg-info/10 text-info',         label: 'Assessment'   },
  interviewing: { cls: 'bg-warning/10 text-warning',   label: 'Interviewing' },
  offer:        { cls: 'bg-success/10 text-success',   label: 'Offer'        },
  rejected:     { cls: 'bg-danger/10 text-danger',     label: 'Rejected'     },
  saved:        { cls: 'bg-surface-2 text-muted',      label: 'Saved'        },
}

function EmailStatusBadge({ s }) {
  const styles = {
    sent:    'bg-success/10 text-success',
    failed:  'bg-danger/10 text-danger',
    pending: 'bg-warning/10 text-warning',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${styles[s] || 'bg-surface-2 text-muted'}`}>
      {s}
    </span>
  )
}

export default function Outreach() {
  const [data, setData]       = useState(null)
  const [search, setSearch]   = useState('')
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)   // flash "Saved!" confirmation

  // Per-row reply state: { [id]: { open, text, saving } }
  const [replies, setReplies]     = useState({})
  // Current status per row (local, possibly unsaved)
  const [statuses, setStatuses]   = useState({})
  // Original statuses from DB — used to detect dirty rows
  const [origStatuses, setOrigStatuses] = useState({})

  useEffect(() => {
    fetch('/api/outreach').then(r => r.json()).then(d => {
      setData(d)
      const s = {}; const r = {}
      ;(d.rows || []).forEach(o => {
        s[o.id] = o.tracker_status || null
        r[o.id] = { open: false, text: o.tracker_notes || '', saving: false }
      })
      setStatuses(s)
      setOrigStatuses(s)
      setReplies(r)
    })
  }, [])

  const rows = data?.rows || []

  // Rows whose status has changed from what's in the DB
  const dirtyIds = Object.keys(statuses).filter(id => statuses[id] !== origStatuses[id])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(o =>
      (o.title || '').toLowerCase().includes(q) ||
      (o.company || '').toLowerCase().includes(q) ||
      (o.to_email || '').toLowerCase().includes(q) ||
      (o.subject || '').toLowerCase().includes(q) ||
      (o.recruiter_name || '').toLowerCase().includes(q)
    )
  }, [rows, search])

  // Only update local state — no API call yet
  function updateStatus(id, newStatus) {
    setStatuses(s => ({ ...s, [id]: newStatus }))
  }

  // Save all dirty status changes in parallel
  async function saveAll() {
    if (!dirtyIds.length || saving) return
    setSaving(true)
    const byId = {}
    rows.forEach(o => { byId[o.id] = o })
    await Promise.all(
      dirtyIds.map(id => {
        const o = byId[id]
        if (!o) return Promise.resolve()
        return fetch(`/api/tracker/${o.target_job_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: statuses[id] }),
        })
      })
    )
    setOrigStatuses(s => {
      const next = { ...s }
      dirtyIds.forEach(id => { next[id] = statuses[id] })
      return next
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function toggleReply(id) {
    setReplies(r => ({ ...r, [id]: { ...r[id], open: !r[id]?.open } }))
  }

  function setReplyText(id, text) {
    setReplies(r => ({ ...r, [id]: { ...r[id], text } }))
  }

  async function saveReply(o) {
    const id = o.id
    setReplies(r => ({ ...r, [id]: { ...r[id], saving: true } }))
    await fetch(`/api/tracker/${o.target_job_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: statuses[id] || 'applied', notes: replies[id]?.text || '' }),
    })
    setReplies(r => ({ ...r, [id]: { ...r[id], saving: false, open: false } }))
  }

  if (!data) return <Loading />

  const interviews = rows.filter(o => ['interviewing', 'assessment'].includes(statuses[o.id])).length
  const offers     = rows.filter(o => statuses[o.id] === 'offer').length
  const withNotes  = rows.filter(o => replies[o.id]?.text).length

  return (
    <>
      <PageHeader title="Outreach" subtitle="Every cold email sent — update application status, log recruiter replies, and track outcomes." />

      {/* KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <StatCard icon="outgoing_mail"  label="Emails Sent"   value={data.sent}    tone="success" />
        <StatCard icon="error"          label="Failed"         value={data.failed}  tone="danger"  />
        <StatCard icon="forum"          label="Interviewing"   value={interviews}   tone="warning" />
        <StatCard icon="sticky_note_2"  label="Replies Logged" value={withNotes}    tone="accent"  />
      </div>

      {/* Unsaved changes banner */}
      {(dirtyIds.length > 0 || saved) && (
        <div className={`rounded-xl px-5 py-3 mb-4 flex items-center gap-3 border transition-colors ${
          saved ? 'bg-success/10 border-success/30' : 'bg-accent/5 border-accent/30'}`}>
          <span className="material-symbols-outlined text-[18px] flex-shrink-0"
            style={{ color: saved ? 'rgb(var(--success))' : 'rgb(var(--accent))' }}>
            {saved ? 'check_circle' : 'edit_note'}
          </span>
          <p className="text-[12px] font-semibold flex-1"
            style={{ color: saved ? 'rgb(var(--success))' : 'rgb(var(--ink))' }}>
            {saved
              ? 'Changes saved successfully'
              : `${dirtyIds.length} unsaved status change${dirtyIds.length > 1 ? 's' : ''}`}
          </p>
          {!saved && (
            <>
              <button onClick={() => setStatuses({ ...origStatuses })}
                className="text-[11px] text-muted hover:text-ink transition-colors px-2">
                Discard
              </button>
              <button onClick={saveAll} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg gradient-accent text-accent-ink text-[11px] font-bold hover:opacity-90 transition-opacity disabled:opacity-60">
                {saving
                  ? <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  : <span className="material-symbols-outlined text-[13px]">save</span>}
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Search */}
      <div className="card rounded-2xl px-4 py-3 mb-4">
        <div className="relative max-w-sm">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-faint pointer-events-none">search</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by job title, company, email, subject…"
            className={`${inputCls} w-full !pl-9 !py-2 !text-xs`} />
          {search && (
            <button onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-muted transition-colors">
              <span className="material-symbols-outlined text-[15px]">close</span>
            </button>
          )}
        </div>
        {search && (
          <p className="text-[11px] text-muted mt-2">
            {filtered.length} of {rows.length} emails
          </p>
        )}
      </div>

      {/* Table */}
      <div className="card rounded-2xl overflow-hidden">
        {!filtered.length ? (
          <EmptyState icon="mail" title={search ? 'No matches' : 'No emails sent yet'}
            hint={search ? 'Try a different search term.' : 'Open a job and hit Apply, or run scripts/send_outreach.py.'} />
        ) : (
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left border-collapse">
              <thead className="bg-surface-2 border-b border-line">
                <tr>
                  {['Email', 'Job', 'Recruiter', 'Subject', 'Sent', 'Score', 'App Status', 'Reply', ''].map((h, i) => (
                    <th key={i} className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-muted whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map(o => {
                  const reply  = replies[o.id] || { open: false, text: '', saving: false }
                  const status = statuses[o.id]
                  const ts     = TRACKER_STYLE[status]

                  return (
                    <>
                      <tr key={o.id} className="hover:bg-surface-2/50 transition-colors group">

                        {/* Email send status */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <EmailStatusBadge s={o.status} />
                        </td>

                        {/* Job */}
                        <td className="px-4 py-3 max-w-[180px]">
                          <Link to={`/ats/${o.target_job_id}`}
                            className="font-semibold text-[12px] text-ink hover:text-accent transition-colors truncate block leading-tight">
                            {o.title || 'Untitled'}
                          </Link>
                          <span className="text-[10px] text-faint truncate block mt-0.5">{o.company || '—'}</span>
                        </td>

                        {/* Recruiter email */}
                        <td className="px-4 py-3 text-[11px] font-mono text-muted max-w-[160px] truncate">
                          {o.to_email}
                        </td>

                        {/* Subject */}
                        <td className="px-4 py-3 text-[11px] text-muted max-w-[200px] truncate">
                          {o.subject || '—'}
                        </td>

                        {/* Sent at */}
                        <td className="px-4 py-3 text-[10px] text-faint whitespace-nowrap tabular-nums">
                          {o.sent_at ? o.sent_at.slice(0, 16).replace('T', ' ') : '—'}
                        </td>

                        {/* ATS score */}
                        <td className="px-4 py-3">
                          {o.final_ats_score != null
                            ? <span className="text-[13px] font-bold tabular-nums" style={{ color: scoreColor(o.final_ats_score) }}>{o.final_ats_score}</span>
                            : <span className="text-faint text-[11px]">—</span>}
                        </td>

                        {/* Application status dropdown */}
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="relative">
                            <select
                              value={status || ''}
                              onChange={e => updateStatus(o.id, e.target.value)}
                              className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border-0 outline-none cursor-pointer appearance-none pr-6 transition-colors ${
                                ts ? ts.cls : 'bg-surface-2 text-faint'}`}
                              style={{ backgroundImage: 'none' }}>
                              <option value="" disabled>Set status…</option>
                              {TRACKER_STATUSES.map(s => (
                                <option key={s} value={s} className="bg-surface text-ink text-xs font-normal">
                                  {TRACKER_STYLE[s]?.label}
                                </option>
                              ))}
                            </select>
                            <span className="material-symbols-outlined text-[11px] absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none opacity-50">expand_more</span>
                          </div>
                        </td>

                        {/* Reply / notes toggle */}
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <button onClick={() => toggleReply(o.id)}
                            title={reply.text ? 'View/edit reply' : 'Log a reply'}
                            className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors ${
                              reply.text ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-muted hover:text-accent hover:bg-accent/10'}`}>
                            <span className="material-symbols-outlined text-[13px]">
                              {reply.text ? 'chat' : 'add_comment'}
                            </span>
                            {reply.text ? 'Reply' : 'Log'}
                          </button>
                        </td>

                        {/* Link to job detail */}
                        <td className="px-4 py-3">
                          <Link to={`/ats/${o.target_job_id}`} className="text-faint hover:text-accent transition-colors">
                            <span className="material-symbols-outlined text-[17px]">open_in_new</span>
                          </Link>
                        </td>
                      </tr>

                      {/* Inline reply panel */}
                      {reply.open && (
                        <tr key={`${o.id}-reply`} className="bg-accent/[0.03] border-b border-accent/10">
                          <td colSpan="9" className="px-6 py-4">
                            <div className="max-w-2xl space-y-3">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="material-symbols-outlined text-[16px] text-accent">chat_bubble</span>
                                <span className="text-[12px] font-semibold text-ink">
                                  Log reply from <span className="text-accent">{o.recruiter_name || o.to_email}</span>
                                </span>
                              </div>
                              <textarea
                                value={reply.text}
                                onChange={e => setReplyText(o.id, e.target.value)}
                                placeholder="Paste the recruiter's reply or add any notes about this application…"
                                rows={3}
                                className="w-full bg-surface border border-line rounded-xl px-4 py-3 text-[12px] text-ink placeholder:text-faint focus:ring-2 focus:ring-accent/40 focus:border-accent outline-none resize-none transition-colors"
                              />
                              <div className="flex items-center gap-3">
                                <button onClick={() => saveReply(o)} disabled={reply.saving}
                                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg gradient-accent text-accent-ink text-[11px] font-bold hover:opacity-90 transition-opacity disabled:opacity-50">
                                  <span className="material-symbols-outlined text-[13px]">save</span>
                                  {reply.saving ? 'Saving…' : 'Save'}
                                </button>
                                <button onClick={() => toggleReply(o.id)}
                                  className="text-[11px] text-muted hover:text-ink transition-colors">
                                  Cancel
                                </button>
                                {reply.text && (
                                  <span className="ml-auto text-[10px] text-faint">{reply.text.length} chars</span>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer */}
        {filtered.length > 0 && (
          <div className="bg-surface-2 px-5 py-2.5 border-t border-line">
            <p className="text-[11px] text-muted">
              {filtered.length} email{filtered.length !== 1 ? 's' : ''}
              {search && ` matching "${search}"`}
              &nbsp;·&nbsp;
              <span className="text-success font-semibold">{data.sent} sent</span>
              {data.failed > 0 && <span className="text-danger font-semibold ml-2">{data.failed} failed</span>}
            </p>
          </div>
        )}
      </div>
    </>
  )
}
