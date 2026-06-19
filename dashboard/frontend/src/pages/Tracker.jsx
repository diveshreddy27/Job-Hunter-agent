import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import EmailComposer from '../components/EmailComposer'
import { PageHeader, ScoreChip, TRACKER_META, EmptyState, Loading, selectCls } from '../components/ui'

function staggerDelay(i, step = 0.055, cap = 0.48) {
  return `${Math.min(i * step, cap)}s`
}

const COLUMNS = ['saved', 'applied', 'interviewing', 'offer', 'rejected']

export default function Tracker() {
  const [items, setItems] = useState(null)
  const [notesDraft, setNotesDraft] = useState({})
  const [composing, setComposing] = useState(null)

  const load = useCallback(() => {
    fetch('/api/tracker').then(r => r.json()).then(setItems)
  }, [])

  useEffect(() => { load() }, [load])

  async function setStatus(id, status) {
    await fetch(`/api/tracker/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    load()
  }

  async function remove(id) {
    await fetch(`/api/tracker/${id}`, { method: 'DELETE' })
    load()
  }

  async function saveNotes(id) {
    const item = items.find(i => i.target_job_id === id)
    await fetch(`/api/tracker/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: item.status, notes: notesDraft[id] ?? '' }),
    })
    setNotesDraft(d => { const n = { ...d }; delete n[id]; return n })
    load()
  }

  if (!items) return <Loading />

  const byStatus = Object.fromEntries(COLUMNS.map(c => [c, items.filter(i => i.status === c)]))
  const active = items.filter(i => !['rejected'].includes(i.status)).length

  return (
    <>
      <PageHeader
        title="Application Tracker"
        subtitle={`${items.length} tracked · ${active} active. Save jobs from the Jobs tab, then move them through your funnel.`}
      />

      {!items.length ? (
        <div className="card rounded-2xl">
          <EmptyState icon="fact_check" title="Nothing tracked yet"
            hint="Open the Jobs tab and hit the bookmark icon on roles you want to pursue." />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-start">
          {COLUMNS.map((col, colIdx) => {
            const meta = TRACKER_META[col]
            const colItems = byStatus[col]
            return (
              <div key={col} className="bg-surface-2/60 border border-line rounded-2xl p-3 min-h-[120px] fade-up" style={{ animationDelay: staggerDelay(colIdx) }}>
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded-lg mb-3 ${meta.cls}`}>
                  <span className="material-symbols-outlined text-[16px]">{meta.icon}</span>
                  <span className="text-xs font-bold uppercase tracking-wide">{meta.label}</span>
                  <span className="ml-auto text-xs font-mono font-bold">{colItems.length}</span>
                </div>
                <div className="space-y-3">
                  {colItems.map((item, itemIdx) => {
                    const editing = item.target_job_id in notesDraft
                    return (
                      <div key={item.target_job_id} className="card rounded-xl p-3.5 space-y-2.5 card-hover group pop-in" style={{ animationDelay: staggerDelay(itemIdx, 0.045, 0.36) }}>
                        <div className="flex items-start gap-2.5">
                          <ScoreChip score={item.final_ats_score} />
                          <div className="min-w-0">
                            <Link to={`/ats/${item.target_job_id}`}
                              className="font-semibold text-ink text-[13px] leading-4 hover:text-accent transition-colors line-clamp-2">
                              {item.title || 'Untitled'}
                            </Link>
                            <p className="text-[11px] text-muted truncate mt-0.5">{item.company || '—'}</p>
                          </div>
                        </div>

                        {editing ? (
                          <div>
                            <textarea
                              autoFocus rows={3}
                              value={notesDraft[item.target_job_id]}
                              onChange={e => setNotesDraft(d => ({ ...d, [item.target_job_id]: e.target.value }))}
                              className="w-full bg-surface-2 border border-line rounded-lg p-2 text-xs text-ink outline-none focus:border-accent resize-none"
                              placeholder="Notes — referral, follow-up date…"
                            />
                            <button onClick={() => saveNotes(item.target_job_id)}
                              className="text-accent text-[11px] font-bold hover:underline">Save notes</button>
                          </div>
                        ) : item.notes ? (
                          <p onClick={() => setNotesDraft(d => ({ ...d, [item.target_job_id]: item.notes }))}
                            className="text-[11px] text-muted bg-surface-2 rounded-lg p-2 leading-4 cursor-text whitespace-pre-wrap">
                            {item.notes}
                          </p>
                        ) : null}

                        <div className="flex items-center gap-1.5 pt-1 border-t border-line">
                          <select
                            value={item.status}
                            onChange={e => setStatus(item.target_job_id, e.target.value)}
                            className={`${selectCls} !text-[11px] !px-2 !py-1 flex-1`}
                          >
                            {COLUMNS.map(s => <option key={s} value={s}>{TRACKER_META[s].label}</option>)}
                          </select>
                          {!editing && !item.notes && (
                            <button title="Add notes"
                              onClick={() => setNotesDraft(d => ({ ...d, [item.target_job_id]: '' }))}
                              className="text-faint hover:text-accent transition-colors">
                              <span className="material-symbols-outlined text-[18px]">edit_note</span>
                            </button>
                          )}
                          {item.recruiter_email && (
                            <button title={`Email ${item.recruiter_email}`}
                              onClick={() => setComposing({ target_id: item.target_job_id, recruiter_email: item.recruiter_email, title: item.title })}
                              className="text-faint hover:text-accent transition-colors">
                              <span className="material-symbols-outlined text-[17px]">send</span>
                            </button>
                          )}
                          <button title="Remove from tracker" onClick={() => remove(item.target_job_id)}
                            className="text-faint hover:text-danger transition-colors">
                            <span className="material-symbols-outlined text-[17px]">delete</span>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {!colItems.length && (
                    <p className="text-center text-faint text-[11px] py-4">Empty</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {composing && (
        <EmailComposer
          job={composing}
          onClose={() => setComposing(null)}
          onSent={load}
        />
      )}
    </>
  )
}
