// Shared UI primitives — all theme-aware via semantic Tailwind tokens.
import { scoreColor } from './charts'

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-wrap justify-between items-end gap-4 mb-7 fade-up">
      <div>
        <h2 className="text-[28px] font-extrabold leading-9 tracking-tight gradient-text">{title}</h2>
        {subtitle && <p className="text-muted text-sm mt-1.5 max-w-2xl">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  )
}

export function Card({ className = '', children, title, icon, action, hover = false }) {
  return (
    <div className={`card rounded-2xl ${hover ? 'card-hover cursor-pointer' : ''} ${className}`}>
      {(title || action) && (
        <div className="px-6 pt-5 pb-0 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2">
            {icon && (
              <span className="w-7 h-7 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
                <span className="material-symbols-outlined text-[18px]">{icon}</span>
              </span>
            )}
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
    accent:  { text: 'text-accent',  glow: 'rgb(var(--accent) / 0.18)' },
    success: { text: 'text-success', glow: 'rgb(var(--success) / 0.18)' },
    warning: { text: 'text-warning', glow: 'rgb(var(--warning) / 0.18)' },
    danger:  { text: 'text-danger',  glow: 'rgb(var(--danger) / 0.18)' },
    info:    { text: 'text-info',    glow: 'rgb(var(--info) / 0.18)' },
  }
  const t = tones[tone] || tones.accent
  return (
    <div className="card card-hover rounded-2xl p-5 flex items-center gap-4 overflow-hidden">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${t.text}`}
        style={{ background: `radial-gradient(circle at 30% 25%, ${t.glow}, rgb(var(--surface-2)))`, boxShadow: `0 6px 18px -8px ${t.glow}` }}>
        <span className="material-symbols-outlined text-[24px]">{icon}</span>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-muted uppercase tracking-wider font-semibold truncate">{label}</p>
        <p className="text-[27px] font-extrabold text-ink leading-8 tracking-tight">{value}</p>
        {sub && <p className="text-[11px] text-faint truncate">{sub}</p>}
      </div>
    </div>
  )
}

export function ScoreChip({ score, size = 'md' }) {
  const c = scoreColor(score)
  const dim = size === 'lg' ? 'w-11 h-11 text-sm' : 'w-9 h-9 text-xs'
  return (
    <div className={`${dim} rounded-full flex items-center justify-center font-bold shrink-0 relative`}
      style={{ color: c, background: `conic-gradient(${c} ${(score ?? 0) * 3.6}deg, rgb(var(--surface-2)) 0deg)` }}>
      <span className="absolute inset-[2.5px] rounded-full bg-surface flex items-center justify-center">{score ?? '—'}</span>
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

// ── Cloud fit (the pipeline's core outreach signal) ──────────────────────────
export const CLOUD_FIT_META = {
  aws_match:        { label: 'AWS Match',   cls: 'bg-success/10 text-success', icon: 'cloud_done' },
  no_cloud_req:     { label: 'No Cloud Req', cls: 'bg-info/10 text-info',      icon: 'cloud_off' },
  other_cloud_only: { label: 'Other Cloud', cls: 'bg-warning/10 text-warning', icon: 'cloud' },
}

export function CloudFitPill({ fit }) {
  const m = CLOUD_FIT_META[fit]
  if (!m) return <span className="text-faint text-xs">—</span>
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${m.cls}`}>
      <span className="material-symbols-outlined text-[12px]">{m.icon}</span>{m.label}
    </span>
  )
}

const CLOUD_CHIP = {
  aws:   'bg-warning/10 text-warning',
  azure: 'bg-info/10 text-info',
  gcp:   'bg-danger/10 text-danger',
}
export function CloudChips({ clouds = [] }) {
  if (!clouds.length) return null
  return (
    <span className="inline-flex gap-1">
      {clouds.map(c => (
        <span key={c} className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${CLOUD_CHIP[c.toLowerCase()] || 'bg-surface-2 text-muted'}`}>{c}</span>
      ))}
    </span>
  )
}

// Relative "x ago" from an ISO timestamp. Returns { text, fresh } — fresh = within 48h.
export function relativeTime(iso) {
  if (!iso) return { text: '—', fresh: false, stale: false }
  const then = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z')
  const mins = Math.floor((Date.now() - then.getTime()) / 60000)
  if (isNaN(mins)) return { text: '—', fresh: false, stale: false }
  const fresh = mins <= 48 * 60
  const stale = mins > 7 * 24 * 60
  let text
  if (mins < 1) text = 'just now'
  else if (mins < 60) text = `${mins}m ago`
  else if (mins < 1440) text = `${Math.floor(mins / 60)}h ago`
  else text = `${Math.floor(mins / 1440)}d ago`
  return { text, fresh, stale }
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
    <div className="flex items-center justify-center gap-3 py-24 text-muted text-sm" role="status" aria-live="polite">
      <span className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin" aria-hidden="true" />
      Loading…
    </div>
  )
}

// ── Skeleton loading primitives ──────────────────────────────────────────────
// Mirror the final layout's shape so content doesn't jump in when it arrives.
export function Skeleton({ className = '' }) {
  return <div className={`skeleton rounded-lg ${className}`} aria-hidden="true" />
}

export function StatCardSkeleton() {
  return (
    <div className="card rounded-2xl p-5 flex items-center gap-4">
      <Skeleton className="w-11 h-11 rounded-xl shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-12" />
        <Skeleton className="h-2.5 w-24" />
      </div>
    </div>
  )
}

export const inputCls =
  'bg-surface border-2 border-line text-ink text-sm rounded-lg px-3 py-2 ' +
  'placeholder:text-faint focus:ring-2 focus:ring-accent/40 focus:border-accent outline-none transition-colors ' +
  'hover:border-surface-3'

export const selectCls =
  'bg-surface border-2 border-line text-ink text-xs rounded-lg px-3 py-1.5 ' +
  'focus:ring-2 focus:ring-accent/40 focus:border-accent outline-none cursor-pointer ' +
  'hover:border-surface-3 transition-colors'
