import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { scoreColor } from '../components/charts'
import { PageHeader, StatCard, EmptyState, Loading } from '../components/ui'

function StatusBadge({ s }) {
  const styles = { sent: 'bg-success/10 text-success', failed: 'bg-danger/10 text-danger', pending: 'bg-warning/10 text-warning' }
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${styles[s] || 'bg-surface-2 text-muted'}`}>{s}</span>
}

export default function Outreach() {
  const [data, setData] = useState(null)
  const [missing, setMissing] = useState(null)

  useEffect(() => {
    fetch('/api/outreach').then(r => r.json()).then(setData)
    fetch('/api/missing-fields').then(r => r.json()).then(setMissing)
  }, [])

  if (!data) return <Loading />

  const missingFields = missing?.fields || {}
  const missingList = Object.entries(missingFields)

  return (
    <>
      <PageHeader title="Outreach" subtitle="Every cold email the agent has sent, plus profile fields recruiters keep asking for." />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <StatCard icon="outgoing_mail" label="Emails Sent" value={data.sent} tone="success" />
        <StatCard icon="error" label="Failed" value={data.failed} tone="danger" />
        <StatCard icon="forum" label="Total Attempts" value={data.total} tone="accent" />
        <StatCard icon="assignment_late" label="Missing Profile Fields" value={missing?.total_unique ?? 0} tone="warning" />
      </div>

      <div className="grid grid-cols-12 gap-5">
        {/* Sent history */}
        <div className="col-span-12 xl:col-span-8 card rounded-2xl overflow-hidden">
          <div className="px-6 pt-5 pb-3 flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-accent">history</span>
            <h3 className="text-sm font-bold text-ink">Email History</h3>
          </div>
          {!data.rows.length ? (
            <EmptyState icon="mail" title="No emails sent yet"
              hint="Open a job and hit Send Email, or run scripts/send_outreach.py." />
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead className="bg-surface-2 border-b border-line">
                  <tr>
                    {['Status', 'Job', 'To', 'Subject', 'When', 'Score', ''].map((h, i) => (
                      <th key={i} className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-muted whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.rows.map(o => (
                    <tr key={o.id} className="hover:bg-surface-2 transition-colors">
                      <td className="px-5 py-3"><StatusBadge s={o.status} /></td>
                      <td className="px-5 py-3 max-w-[180px]">
                        <Link to={`/ats/${o.target_job_id}`} className="font-semibold text-ink text-sm truncate hover:text-accent block">{o.title || 'Untitled'}</Link>
                        <span className="text-[11px] text-faint truncate block">{o.company || '—'}</span>
                      </td>
                      <td className="px-5 py-3 text-xs font-mono text-muted max-w-[160px] truncate">{o.to_email}</td>
                      <td className="px-5 py-3 text-xs text-muted max-w-[220px] truncate">{o.subject || '—'}</td>
                      <td className="px-5 py-3 text-[11px] font-mono text-faint whitespace-nowrap">{o.sent_at ? o.sent_at.slice(0, 16).replace('T', ' ') : '—'}</td>
                      <td className="px-5 py-3">
                        {o.final_ats_score != null
                          ? <span className="font-bold text-sm" style={{ color: scoreColor(o.final_ats_score) }}>{o.final_ats_score}</span>
                          : <span className="text-faint">—</span>}
                      </td>
                      <td className="px-5 py-3">
                        <Link to={`/ats/${o.target_job_id}`} className="text-faint hover:text-accent">
                          <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Missing fields */}
        <div className="col-span-12 xl:col-span-4 card rounded-2xl">
          <div className="px-6 pt-5 pb-1 flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-accent">assignment_late</span>
            <h3 className="text-sm font-bold text-ink">Missing Profile Fields</h3>
          </div>
          <div className="p-6">
            <p className="text-xs text-muted mb-4">
              Fields recruiters asked for that weren't in your <code className="text-accent">candidate_info.txt</code>. Fill these in to stop losing points.
            </p>
            {missingList.length ? (
              <div className="space-y-2.5">
                {missingList.map(([field, info]) => (
                  <div key={field} className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-ink capitalize">{field.replace(/_/g, ' ')}</span>
                    <span className="text-[11px] font-mono text-warning bg-warning/10 px-2 py-0.5 rounded-full shrink-0">
                      asked {info.count}×
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon="task_alt" title="Nothing missing" hint="Your candidate_info.txt covers every field recruiters asked for." />
            )}
          </div>
        </div>
      </div>
    </>
  )
}
