import { useEffect, useState } from 'react'
import { PageHeader, StatCard, EmptyState, Loading } from '../components/ui'

function staggerDelay(i, step = 0.055, cap = 0.48) {
  return `${Math.min(i * step, cap)}s`
}

export default function ProfileFields() {
  const [data, setData] = useState(null)

  useEffect(() => {
    fetch('/api/missing-fields').then(r => r.json()).then(setData)
  }, [])

  if (!data) return <Loading />

  const fields = Object.entries(data.fields || {})
  const maxCount = fields.reduce((m, [, v]) => Math.max(m, v.count), 0)

  const PRIORITY = count => count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low'
  const PRIORITY_STYLE = {
    high:   { cls: 'bg-danger/10 text-danger',   label: 'High' },
    medium: { cls: 'bg-warning/10 text-warning', label: 'Medium' },
    low:    { cls: 'bg-surface-2 text-faint',    label: 'Low' },
  }

  return (
    <>
      <PageHeader
        title="Profile Fields"
        subtitle="Fields recruiters keep asking for that are missing from your candidate_info.txt — fill these to stop losing points."
      />

      <div className="grid grid-cols-2 xl:grid-cols-3 gap-5 mb-6">
        <div className="fade-up fade-up-1"><StatCard icon="assignment_late" label="Missing Fields"    value={data.total_unique ?? 0} tone="warning" /></div>
        <div className="fade-up fade-up-2"><StatCard icon="priority_high"   label="High Priority"     value={fields.filter(([, v]) => PRIORITY(v.count) === 'high').length}   tone="danger"  /></div>
        <div className="fade-up fade-up-3"><StatCard icon="check_circle"    label="Covered Fields"    value="—" tone="success" /></div>
      </div>

      <div className="card rounded-2xl overflow-hidden fade-up fade-up-4">
        <div className="px-6 pt-5 pb-3 border-b border-line flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-accent">assignment_late</span>
            <h3 className="text-sm font-bold text-ink">Missing from candidate_info.txt</h3>
          </div>
          <span className="text-[11px] text-muted">
            Edit <code className="text-accent text-[11px]">config/candidate_info.txt</code> to fill these in
          </span>
        </div>

        {fields.length === 0 ? (
          <EmptyState icon="task_alt" title="Nothing missing"
            hint="Your candidate_info.txt covers every field recruiters have asked for." />
        ) : (
          <div className="p-6 space-y-3">
            {fields.map(([field, info], i) => {
              const pct  = maxCount ? Math.round(info.count / maxCount * 100) : 0
              const prio = PRIORITY(info.count)
              const ps   = PRIORITY_STYLE[prio]
              return (
                <div key={field} className="flex items-center gap-4 group fade-up" style={{ animationDelay: staggerDelay(i, 0.05, 0.45) }}>
                  {/* Field name */}
                  <div className="w-48 flex-shrink-0">
                    <p className="text-[12px] font-semibold text-ink capitalize leading-tight">
                      {field.replace(/_/g, ' ')}
                    </p>
                    <p className="text-[10px] text-faint font-mono mt-0.5">{field}</p>
                  </div>

                  {/* Bar */}
                  <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${Math.max(pct, 3)}%`, background: prio === 'high' ? 'rgb(var(--danger))' : prio === 'medium' ? 'rgb(var(--warning))' : 'rgb(var(--faint))' }} />
                  </div>

                  {/* Count */}
                  <span className="text-[11px] font-mono text-muted tabular-nums w-16 text-right flex-shrink-0">
                    asked {info.count}×
                  </span>

                  {/* Priority badge */}
                  <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide flex-shrink-0 w-16 text-center pop-in ${ps.cls}`}
                    style={{ animationDelay: staggerDelay(i, 0.05, 0.45) }}>
                    {ps.label}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {fields.length > 0 && (
          <div className="px-6 py-4 border-t border-line bg-surface-2/50">
            <p className="text-[11px] text-muted leading-relaxed">
              <span className="material-symbols-outlined text-[13px] align-middle text-warning mr-1">tips_and_updates</span>
              Open <code className="text-accent">config/candidate_info.txt</code> and add these fields in <code className="text-accent">KEY: value</code> format.
              Each field you fill in means one fewer &quot;(not provided)&quot; in future AI-generated emails.
            </p>
          </div>
        )}
      </div>
    </>
  )
}
