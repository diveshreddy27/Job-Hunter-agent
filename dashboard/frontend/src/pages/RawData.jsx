import { useEffect, useState } from 'react'
import { scoreColor } from '../components/charts'
import { PageHeader, ModePill, relativeTime, EmptyState, Loading, inputCls } from '../components/ui'

function staggerDelay(i, step = 0.055, cap = 0.48) {
  return `${Math.min(i * step, cap)}s`
}

function StatusBadge({ s }) {
  const styles = {
    done: 'bg-success/10 text-success',
    pending: 'bg-warning/10 text-warning',
    failed: 'bg-danger/10 text-danger',
  }
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${styles[s] || 'bg-surface-2 text-muted'}`}>{s}</span>
}

export default function RawData() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [expanded, setExpanded] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ page, limit: 15, q: search })
    fetch('/api/raw-posts?' + params)
      .then(r => r.json())
      .then(d => {
        setRows(d.rows || []); setTotal(d.total || 0); setPages(d.pages || 1); setLoading(false)
      })
  }, [page, search])

  return (
    <>
      <PageHeader title="Raw Posts" subtitle="Every scraped LinkedIn post with its extraction status — the pipeline's source of truth.">
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search posts, authors…"
          className={`${inputCls} w-64`}
        />
        <span className="text-xs font-mono text-muted card px-3 py-2 rounded-xl">{total} posts</span>
      </PageHeader>

      {loading ? <Loading /> : !rows.length ? (
        <div className="card rounded-2xl"><EmptyState title="No posts found" hint="Try a different search, or run the pipeline." /></div>
      ) : (
        <div className="space-y-4">
          {rows.map((r, i) => (
            <div key={r.id} className="card rounded-2xl p-5 hover:border-accent/40 transition-colors fade-up" style={{ animationDelay: staggerDelay(i, 0.06, 0.45) }}>
              <div className="flex flex-wrap justify-between items-start gap-3 mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-accent/12 text-accent flex items-center justify-center font-bold shrink-0">
                    {(r.post_author || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold text-ink text-sm">{r.post_author || 'Unknown'}</p>
                    <p className="text-[11px] text-faint font-mono flex items-center gap-1.5 flex-wrap">
                      {r.posted_at && (() => {
                        const age = relativeTime(r.posted_at)
                        return <span className={age.fresh ? 'text-success' : ''}>posted {age.text} ·</span>
                      })()}
                      scraped {r.scraped_at ? r.scraped_at.slice(0, 16).replace('T', ' ') : '—'} · past {r.days_filter}d
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  <StatusBadge s={r.extraction_status} />
                  {r.final_ats_score != null && (
                    <span className="text-xs font-bold" style={{ color: scoreColor(r.final_ats_score) }}>
                      ATS {r.final_ats_score}
                    </span>
                  )}
                </div>
              </div>

              {r.title && (
                <div className="flex items-center gap-3 mb-3 px-3.5 py-2.5 bg-surface-2 rounded-xl flex-wrap">
                  <span className="material-symbols-outlined text-accent text-[18px]">work</span>
                  <span className="text-xs font-bold text-ink">{r.title}</span>
                  {r.company && <span className="text-muted text-xs">@ {r.company}</span>}
                  <ModePill mode={r.work_mode} />
                  {r.experience_min != null && (
                    <span className="text-faint text-[11px] font-mono">{r.experience_min}–{r.experience_max ?? '?'} yrs</span>
                  )}
                  {r.recruiter_email && (
                    <a href={`mailto:${r.recruiter_email}`} className="text-accent text-[11px] font-mono hover:underline ml-auto">{r.recruiter_email}</a>
                  )}
                </div>
              )}

              <p className={`text-[13px] text-muted leading-relaxed whitespace-pre-line ${expanded[r.id] ? '' : 'line-clamp-3'}`}>
                {r.post_content || ''}
              </p>
              <div className="flex items-center gap-4 mt-1.5">
                {(r.post_content || '').length > 220 && (
                  <button
                    onClick={() => setExpanded(p => ({ ...p, [r.id]: !p[r.id] }))}
                    className="text-accent text-xs font-semibold hover:underline cursor-pointer">
                    {expanded[r.id] ? 'Show less' : 'Show more'}
                  </button>
                )}
                {r.post_url && (
                  <a href={r.post_url} target="_blank" rel="noopener noreferrer"
                    className="text-faint text-xs font-semibold hover:text-accent transition-colors inline-flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>View on LinkedIn
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-8">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="card px-4 py-2 rounded-xl text-muted hover:text-accent disabled:opacity-30 text-xs font-semibold transition-colors">
            ← Prev
          </button>
          <span className="text-xs font-mono text-muted">Page {page} / {pages}</span>
          <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}
            className="card px-4 py-2 rounded-xl text-muted hover:text-accent disabled:opacity-30 text-xs font-semibold transition-colors">
            Next →
          </button>
        </div>
      )}
    </>
  )
}
