// Shared UI primitives — all theme-aware via semantic Tailwind tokens.
import { scoreColor } from './charts'

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-wrap justify-between items-end gap-4 mb-7">
      <div>
        <h2 className="text-[26px] font-bold leading-9 text-ink tracking-tight">{title}</h2>
        {subtitle && <p className="text-muted text-sm mt-1">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  )
}

export function Card({ className = '', children, title, icon, action }) {
  return (
    <div className={`card rounded-2xl ${className}`}>
      {(title || action) && (
        <div className="px-6 pt-5 pb-0 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            {icon && <span className="material-symbols-outlined text-[20px] text-accent">{icon}</span>}
            {title}
          </h3>
          {action}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  )
}

export function StatCard({ icon, label, value, sub, tone = 'accent' }) {
  const tones = {
    accent:  'text-accent bg-accent/10',
    success: 'text-success bg-success/10',
    warning: 'text-warning bg-warning/10',
    danger:  'text-danger bg-danger/10',
    info:    'text-info bg-info/10',
  }
  return (
    <div className="card rounded-2xl p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${tones[tone]}`}>
        <span className="material-symbols-outlined text-[22px]">{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-muted uppercase tracking-wider font-semibold truncate">{label}</p>
        <p className="text-2xl font-bold text-ink leading-7">{value}</p>
        {sub && <p className="text-[11px] text-faint truncate">{sub}</p>}
      </div>
    </div>
  )
}

export function ScoreChip({ score, size = 'md' }) {
  const c = scoreColor(score)
  const dim = size === 'lg' ? 'w-11 h-11 text-sm' : 'w-9 h-9 text-xs'
  return (
    <div className={`${dim} rounded-full border-2 flex items-center justify-center font-bold bg-surface shrink-0`}
      style={{ borderColor: c, color: c }}>
      {score ?? '—'}
    </div>
  )
}

export function ModePill({ mode }) {
  if (!mode) return <span className="text-faint text-xs">—</span>
  const styles = {
    remote: 'bg-success/10 text-success',
    hybrid: 'bg-warning/10 text-warning',
    onsite: 'bg-info/10 text-info',
  }
  return (
    <span className={`text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wide ${styles[mode] || 'bg-surface-2 text-muted'}`}>
      {mode}
    </span>
  )
}

export const TRACKER_META = {
  saved:        { label: 'Saved',        icon: 'bookmark',        cls: 'bg-info/10 text-info' },
  applied:      { label: 'Applied',      icon: 'send',            cls: 'bg-accent/10 text-accent' },
  interviewing: { label: 'Interviewing', icon: 'forum',           cls: 'bg-warning/10 text-warning' },
  offer:        { label: 'Offer',        icon: 'celebration',     cls: 'bg-success/10 text-success' },
  rejected:     { label: 'Rejected',     icon: 'block',           cls: 'bg-danger/10 text-danger' },
}

export function TrackerBadge({ status }) {
  const m = TRACKER_META[status]
  if (!m) return null
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${m.cls}`}>
      <span className="material-symbols-outlined text-[12px]">{m.icon}</span>{m.label}
    </span>
  )
}

export function EmptyState({ icon = 'search_off', title, hint }) {
  return (
    <div className="text-center py-16">
      <span className="material-symbols-outlined text-[44px] text-faint">{icon}</span>
      <p className="text-ink font-semibold mt-3">{title}</p>
      {hint && <p className="text-muted text-sm mt-1">{hint}</p>}
    </div>
  )
}

export function Loading() {
  return (
    <div className="flex items-center justify-center gap-3 py-24 text-muted text-sm">
      <span className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      Loading…
    </div>
  )
}

export const inputCls =
  'bg-surface border border-line text-ink text-sm rounded-lg px-3 py-2 ' +
  'placeholder:text-faint focus:ring-2 focus:ring-accent/40 focus:border-accent outline-none transition-colors'

export const selectCls =
  'bg-surface border border-line text-ink text-xs rounded-lg px-3 py-1.5 ' +
  'focus:ring-2 focus:ring-accent/40 focus:border-accent outline-none cursor-pointer'
