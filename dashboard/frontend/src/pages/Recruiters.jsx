import { useEffect, useState } from 'react'
import { scoreColor } from '../components/charts'
import { PageHeader, StatCard, EmptyState, Loading, inputCls } from '../components/ui'

export default function Recruiters() {
  const [allData, setAllData] = useState(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/recruiters').then(r => r.json()).then(setAllData)
  }, [])

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
  const scores = allData.filter(r => r.avg_score).map(r => r.avg_score)
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0

  return (
    <>
      <PageHeader title="Recruiter Directory" subtitle="Every unique recruiter the agent has found, with contact intel.">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, company…"
          className={`${inputCls} w-64`}
        />
      </PageHeader>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        <StatCard icon="contact_page" label="Total Recruiters" value={allData.length} tone="accent" />
        <StatCard icon="mark_email_read" label="With Email" value={allData.filter(r => r.recruiter_email).length} tone="success" />
        <StatCard icon="business" label="Unique Companies" value={uniqueCompanies.size} tone="warning" />
        <StatCard icon="analytics" label="Avg Score Posted" value={avgScore ? `${avgScore}/100` : '—'} tone="info" />
      </div>

      <div className="card rounded-2xl overflow-hidden">
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left">
            <thead className="bg-surface-2 border-b border-line">
              <tr>
                {['Recruiter', 'Company', 'Email', 'Posts', 'Best Score', 'Hiring For', 'Last Seen', ''].map((h, i) => (
                  <th key={i} className="px-5 py-3.5 text-[11px] font-bold uppercase tracking-wider text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {!filtered.length ? (
                <tr><td colSpan="8"><EmptyState title="No recruiters found" /></td></tr>
              ) : filtered.map((r, idx) => {
                const initials = (r.recruiter_name || r.recruiter_email || '?').slice(0, 2).toUpperCase()
                return (
                  <tr key={idx} className="hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-accent/12 text-accent flex items-center justify-center font-bold text-[12px] shrink-0">{initials}</div>
                        <div className="min-w-0">
                          <p className="font-semibold text-ink text-sm truncate">{r.recruiter_name || '—'}</p>
                          <p className="text-[11px] text-faint truncate">{r.recruiter_designation || ''}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-sm text-muted max-w-[150px] truncate">{r.recruiter_current_company || '—'}</td>
                    <td className="px-5 py-3.5">
                      <a href={`mailto:${r.recruiter_email}`} className="text-accent text-xs font-mono hover:underline">{r.recruiter_email}</a>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex w-7 h-7 rounded-full bg-surface-2 items-center justify-center font-bold text-ink text-xs">{r.post_count}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      {r.best_score
                        ? <span className="font-bold text-sm" style={{ color: scoreColor(r.best_score) }}>{r.best_score}</span>
                        : <span className="text-faint">—</span>}
                    </td>
                    <td className="px-5 py-3.5 text-muted text-xs max-w-[180px] truncate">
                      {(r.companies || '').split(',').filter(Boolean).slice(0, 2).join(', ') || '—'}
                    </td>
                    <td className="px-5 py-3.5 text-faint text-xs font-mono whitespace-nowrap">{r.last_seen ? r.last_seen.slice(0, 10) : '—'}</td>
                    <td className="px-5 py-3.5">
                      <a href={`mailto:${r.recruiter_email}`}
                        className="inline-flex items-center gap-1 text-accent hover:underline text-xs font-semibold">
                        <span className="material-symbols-outlined text-[16px]">mail</span>Contact
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="bg-surface-2 px-6 py-3 border-t border-line">
          <p className="text-muted text-xs">Showing {filtered.length} recruiter{filtered.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
    </>
  )
}
