import { useEffect, useState, useRef, useCallback } from 'react'
import { PageHeader } from '../components/ui'

// ── Stage definitions ─────────────────────────────────────────────────────────
const STAGES = [
  {
    id: 'scrape',
    num: '01',
    label: 'Scrape',
    sublabel: 'LinkedIn Posts',
    icon: 'hub',
    colorVar: '--accent',
    desc: 'Playwright scrolls the LinkedIn feed, extracting recruiter posts with "X hours ago" timestamps',
    details: ['Chromium headless', 'Cookie-based auth', 'Infinite scroll', 'StagingWriter batches'],
  },
  {
    id: 'extract',
    num: '02',
    label: 'Extract',
    sublabel: 'AI Normalize',
    icon: 'psychology',
    colorVar: '--info',
    desc: 'Gemini AI parses unstructured post text into structured fields — title, skills, location, email',
    details: ['Gemini Flash Lite', 'Dedup by URN', 'city→state fix', 'exp_max regex fix'],
  },
  {
    id: 'filter',
    num: '03',
    label: 'Filter',
    sublabel: 'Target Jobs',
    icon: 'rule',
    colorVar: '--warning',
    desc: 'Four ordered business checks + cloud fit tagging applied to every normalized post',
    details: ['Location match', 'Experience overlap', 'No contract roles', 'Email required'],
  },
  {
    id: 'score',
    num: '04',
    label: 'Score',
    sublabel: 'ATS Rank',
    icon: 'verified',
    colorVar: '--success',
    desc: '10-model AI cascade (Gemini + Groq) scores each targeted job against your resume',
    details: ['3 parallel workers', 'Best model first', '429 rate-aware', '11 sub-scores'],
  },
]

const TIME_OPTIONS = [
  { label: '24 h', value: 1,  hint: 'Past 24 hours' },
  { label: '7 d',  value: 7,  hint: 'Past 7 days' },
  { label: '30 d', value: 30, hint: 'Past 30 days' },
]

// ── Stage state derivation ────────────────────────────────────────────────────
// All 4 stages start concurrently when the pipeline runs and stay active until
// shutdown — so when running=true every stage is "running". We use metrics to
// show progress, not to gate the running indicator.
function deriveStates(status) {
  if (!status) return { scrape: 'idle', extract: 'idle', filter: 'idle', score: 'idle' }

  const { running, exit_code, stages: s = {} } = status
  const hasData = (s.scrape?.total || 0) > 0

  if (running) {
    return { scrape: 'running', extract: 'running', filter: 'running', score: 'running' }
  }

  if (exit_code === 0) {
    return { scrape: 'done', extract: 'done', filter: 'done', score: 'done' }
  }

  // Server restarted or first visit — derive from DB totals
  return {
    scrape:  hasData                              ? 'done' : 'idle',
    extract: (s.extract?.total_done  || 0) > 0  ? 'done' : 'idle',
    filter:  (s.filter?.total        || 0) > 0  ? 'done' : 'idle',
    score:   (s.score?.total         || 0) > 0  ? 'done' : 'idle',
  }
}

// ── Per-stage metric rows ─────────────────────────────────────────────────────
// Each metric: { label, current, total, warn }
// current = this session, total = all-time. If current===null, no session started.
function stageMetrics(id, status) {
  const s    = status?.stages || {}
  const hasSa = status?.started_at != null   // whether a session has been tracked

  switch (id) {
    case 'scrape': return [
      {
        label:   'Scraped',
        current: hasSa ? (s.scrape?.current ?? 0) : null,
        total:   s.scrape?.total ?? 0,
      },
      {
        label:   'Pending AI',
        current: hasSa ? (s.extract?.current_pending ?? 0) : null,
        total:   s.extract?.total_pending ?? 0,
        warn:    (s.extract?.total_pending || 0) > 0,
      },
    ]
    case 'extract': return [
      {
        label:   'Extracted',
        current: hasSa ? (s.extract?.current_done ?? 0) : null,
        total:   s.extract?.total_done ?? 0,
      },
      {
        label:   'Failed',
        current: hasSa ? (s.extract?.current_failed ?? 0) : null,
        total:   s.extract?.total_failed ?? 0,
        warn:    (s.extract?.total_failed || 0) > 0,
      },
    ]
    case 'filter': return [
      {
        label:   'Targeted',
        current: hasSa ? (s.filter?.current ?? 0) : null,
        total:   s.filter?.total ?? 0,
      },
      {
        label:   'Normalized',
        current: null,                          // no session split for normalized
        total:   s.filter?.normalized ?? 0,
      },
    ]
    case 'score': return [
      {
        label:   'Scored',
        current: hasSa ? (s.score?.current ?? 0) : null,
        total:   s.score?.total ?? 0,
      },
      {
        label:   'Queued',
        current: null,
        total:   s.score?.unscored ?? 0,
        warn:    (s.score?.unscored || 0) > 0,
      },
    ]
    default: return []
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusPill({ state }) {
  const cfg = {
    idle:    { bg: 'rgba(var(--surface-3),0.8)', color: 'rgb(var(--faint))',   dot: 'rgb(var(--faint))',   label: 'Idle',    ping: false, spin: false },
    running: { bg: 'rgba(var(--warning),0.18)',  color: 'rgb(var(--warning))', dot: 'rgb(var(--warning))', label: 'Running', ping: true,  spin: true  },
    done:    { bg: 'rgba(var(--success),0.18)',  color: 'rgb(var(--success))', dot: 'rgb(var(--success))', label: 'Done',    ping: false, spin: false },
    error:   { bg: 'rgba(var(--danger),0.18)',   color: 'rgb(var(--danger))',  dot: 'rgb(var(--danger))',  label: 'Error',   ping: false, spin: false },
  }
  const c = cfg[state] || cfg.idle
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-widest"
      style={{ background: c.bg, color: c.color }}>
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {c.ping && <span className="absolute inset-0 rounded-full animate-ping opacity-70" style={{ background: c.dot }} />}
        <span className="relative h-1.5 w-1.5 rounded-full"
          style={{ background: c.dot, boxShadow: c.ping ? `0 0 5px ${c.dot}` : 'none' }} />
      </span>
      {c.label}
      {c.spin && <span className="w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin ml-0.5" />}
    </span>
  )
}

function FlowEdge({ fromState }) {
  const isActive = fromState === 'running'
  const isDone   = fromState === 'done'
  const stroke   = isActive ? 'rgb(var(--accent))' : isDone ? 'rgb(var(--success))' : 'rgb(var(--surface-3))'

  return (
    <div className="flex items-center justify-center shrink-0" style={{ width: 48 }}>
      <svg width="48" height="24" viewBox="0 0 48 24" style={{ overflow: 'visible' }}>
        {/* Base track */}
        <line x1="0" y1="12" x2="40" y2="12" stroke="rgb(var(--surface-3))" strokeWidth="2" strokeLinecap="round" />
        {/* Active / done fill */}
        {(isActive || isDone) && (
          <line x1="0" y1="12" x2="40" y2="12"
            stroke={stroke} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={isActive ? '6 3' : undefined}
            style={isActive ? {
              animation: 'jh-flow-track 0.45s linear infinite',
              filter: 'drop-shadow(0 0 3px rgb(var(--accent)))',
            } : {}} />
        )}
        {/* Moving particles when running */}
        {isActive && (
          <>
            <circle r="4.5" fill="rgb(var(--accent))"
              style={{ filter: 'drop-shadow(0 0 6px rgb(var(--accent)))' }}>
              <animateTransform attributeName="transform" type="translate"
                from="-5 12" to="45 12" dur="0.75s" repeatCount="indefinite" />
            </circle>
            <circle r="3" fill="rgb(var(--accent))" opacity="0.45">
              <animateTransform attributeName="transform" type="translate"
                from="-5 12" to="45 12" dur="0.75s" begin="0.25s" repeatCount="indefinite" />
            </circle>
            <circle r="1.5" fill="rgb(var(--accent))" opacity="0.22">
              <animateTransform attributeName="transform" type="translate"
                from="-5 12" to="45 12" dur="0.75s" begin="0.5s" repeatCount="indefinite" />
            </circle>
          </>
        )}
        {/* Arrow */}
        <polygon points="42,9 48,12 42,15" fill={stroke} />
      </svg>
    </div>
  )
}

function MetricCell({ m }) {
  const hasSession = m.current !== null
  const showTotal  = m.total != null

  return (
    <div className="rounded-xl p-2.5 text-center" style={{ background: 'rgb(var(--surface-2) / 0.6)' }}>
      {hasSession ? (
        <>
          {/* Session value — big */}
          <p className="text-[22px] font-extrabold leading-tight tracking-tight"
            style={{ color: m.warn ? 'rgb(var(--warning))' : 'rgb(var(--ink))' }}>
            {m.current}
          </p>
          <p className="text-[9px] uppercase tracking-wide mt-0.5 leading-tight" style={{ color: 'rgb(var(--muted))' }}>
            {m.label}
          </p>
          {/* All-time total — small below */}
          {showTotal && (
            <p className="mt-1.5 text-[10px] font-semibold" style={{ color: 'rgb(var(--faint))' }}>
              {m.total}
              <span className="text-[9px] ml-0.5">all‑time</span>
            </p>
          )}
        </>
      ) : (
        <>
          {/* No session — just show total prominently */}
          <p className="text-[22px] font-extrabold leading-tight tracking-tight"
            style={{ color: m.warn ? 'rgb(var(--warning))' : 'rgb(var(--ink))' }}>
            {showTotal ? m.total : '—'}
          </p>
          <p className="text-[9px] uppercase tracking-wide mt-0.5 leading-tight" style={{ color: 'rgb(var(--muted))' }}>
            {m.label}
          </p>
          {showTotal && (
            <p className="mt-1 text-[9px]" style={{ color: 'rgb(var(--faint))' }}>all‑time</p>
          )}
        </>
      )}
    </div>
  )
}

function StageNode({ stage, state, metrics }) {
  const { colorVar, details } = stage
  const isRunning = state === 'running'
  const isDone    = state === 'done'
  const isIdle    = state === 'idle'
  const color     = `rgb(var(${colorVar}))`

  return (
    <div className="relative flex-1 min-w-[165px]">
      {/* Outer bloom glow when running */}
      {isRunning && (
        <div className="absolute -inset-3 rounded-3xl pointer-events-none"
          style={{
            background: `radial-gradient(ellipse at 50% 40%, ${color}28, transparent 68%)`,
            animation: 'jh-pulse-glow 2.4s ease-in-out infinite',
          }} />
      )}

      <div className="relative card rounded-2xl p-5 flex flex-col gap-4 h-full transition-all duration-500"
        style={isRunning ? {
          border: `1px solid ${color}55`,
          boxShadow: `0 0 32px -8px ${color}38, var(--shadow)`,
        } : isDone ? {
          border: `1px solid ${color}28`,
        } : {
          border: '1px solid rgb(var(--line) / 0.35)',
          opacity: 0.68,
        }}>

        {/* Badge + status row */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-black px-2 py-0.5 rounded-lg font-mono tracking-wider"
            style={{ background: `${color}1e`, color }}>
            {stage.num}
          </span>
          <StatusPill state={state} />
        </div>

        {/* Icon + name */}
        <div className="flex flex-col items-center text-center gap-1.5 py-1">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-1"
            style={{
              background: `${color}16`,
              color,
              boxShadow: isRunning
                ? `0 0 0 1px ${color}40, 0 8px 28px -6px ${color}55`
                : isDone
                  ? `0 0 0 1px ${color}22`
                  : 'none',
            }}>
            <span className="material-symbols-outlined text-[30px]"
              style={{ fontVariationSettings: "'FILL' 1" }}>{stage.icon}</span>
          </div>
          <p className="text-[15px] font-black text-ink tracking-tight leading-5">{stage.label}</p>
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'rgb(var(--muted))' }}>
            {stage.sublabel}
          </p>
        </div>

        {/* Metrics — current session / all-time */}
        <div className="grid grid-cols-2 gap-2">
          {metrics.map((m, i) => <MetricCell key={i} m={m} />)}
        </div>

        {/* Description */}
        <p className="text-[11px] leading-[1.55]" style={{ color: 'rgb(var(--faint))' }}>{stage.desc}</p>

        {/* Detail chips */}
        <div className="flex flex-wrap gap-1.5 pt-1 border-t" style={{ borderColor: 'rgb(var(--line) / 0.35)' }}>
          {details.map(d => (
            <span key={d} className="text-[9px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
              style={{
                background: `${color}12`,
                color: isIdle ? 'rgb(var(--faint))' : color,
              }}>
              {d}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Log line colorizer ────────────────────────────────────────────────────────
function logColor(line) {
  const l = line.toLowerCase()
  if (l.includes('error') || l.includes('failed') || l.includes('exception') || l.includes('traceback'))
    return 'rgb(var(--danger))'
  if (l.includes('warn'))
    return 'rgb(var(--warning))'
  if (l.includes('scored') || l.includes('✓') || l.includes('pass') || l.includes('success') || l.includes('done') || l.includes('inserted'))
    return 'rgb(var(--success))'
  if (l.includes('skip') || l.includes('duplicate') || l.includes('dedup') || l.includes('already'))
    return 'rgb(var(--faint))'
  if (l.includes('stage') || l.includes('pipeline') || l.includes('starting') || l.includes('worker') || l.includes('thread'))
    return 'rgb(var(--accent))'
  if (l.includes('gemini') || l.includes('groq') || l.includes('model') || l.includes(' ai '))
    return 'rgb(var(--info))'
  if (l.includes('filter') || l.includes('target') || l.includes('location'))
    return 'rgb(var(--warning))'
  return 'rgb(var(--muted))'
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Pipeline() {
  const [status,   setStatus]   = useState(null)
  const [log,      setLog]      = useState([])
  const [days,     setDays]     = useState(1)
  const [limit,    setLimit]    = useState('')
  const [visible,  setVisible]  = useState(false)
  const [launching, setLaunching] = useState(false)
  const [stopping,  setStopping]  = useState(false)
  const pollRef = useRef(null)
  const logRef  = useRef(null)

  const fetchAll = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        fetch('/api/pipeline-status').then(r => r.json()),
        fetch('/api/pipeline-log').then(r => r.json()),
      ])
      setStatus(s)
      setLog(l.lines || [])
      // Once we confirm it stopped, clear stopping flag
      if (!s.running) setStopping(false)
    } catch {}
    clearTimeout(pollRef.current)
    pollRef.current = setTimeout(fetchAll, 10000)
  }, [])

  useEffect(() => {
    fetchAll()
    return () => clearTimeout(pollRef.current)
  }, [fetchAll])

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function run() {
    setLaunching(true)
    try {
      await fetch('/api/run-pipeline', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ days, limit: parseInt(limit) || 0, visible }),
      })
      await fetchAll()
    } finally {
      setLaunching(false)
    }
  }

  async function stop() {
    setStopping(true)
    try {
      await fetch('/api/stop-pipeline', { method: 'POST' })
      // Poll faster for 30s to catch the exit
      clearTimeout(pollRef.current)
      const fastPoll = async () => {
        await fetchAll()
        if (status?.running !== false) {
          pollRef.current = setTimeout(fastPoll, 2000)
        }
      }
      fastPoll()
    } catch {
      setStopping(false)
    }
  }

  const running   = status?.running
  const stateMap  = deriveStates(status)
  const backlog   = (status?.stages?.extract?.total_pending || 0) + (status?.stages?.score?.unscored || 0)
  const hasSa     = status?.started_at != null

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="fade-up">
        <PageHeader
          title="Pipeline"
          subtitle="Scrape · Extract · Filter · Score — all 4 stages run concurrently in real-time"
        >
          {status && (
            <div className="flex items-center gap-2.5 text-xs">
              <span className="relative flex h-2.5 w-2.5">
                {running && <span className="absolute inset-0 rounded-full bg-warning opacity-60 animate-ping" />}
                <span className="relative h-2.5 w-2.5 rounded-full"
                  style={{
                    background: running ? 'rgb(var(--warning))' : 'rgb(var(--success))',
                    boxShadow:  running ? '0 0 8px rgb(var(--warning))' : '0 0 6px rgb(var(--success))',
                  }} />
              </span>
              <span className="text-muted font-medium">
                {running
                  ? `Running · ${backlog > 0 ? `${backlog} items in backlog` : 'processing…'}`
                  : `Last run ${status.last_run || '—'}`}
              </span>
            </div>
          )}
        </PageHeader>
      </div>

      {/* ── Configure & Run ── */}
      <div className="card rounded-2xl p-6 fade-up-1">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-6 h-6 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
            <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>settings</span>
          </div>
          <h3 className="text-sm font-bold text-ink">Configure Run</h3>
        </div>

        <div className="flex flex-wrap items-end gap-5">

          {/* Time range */}
          <div className="space-y-2">
            <p className="text-[10px] text-muted uppercase tracking-widest font-bold">Time Range</p>
            <div className="pill-group">
              {TIME_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setDays(opt.value)} title={opt.hint}
                  disabled={running}
                  className="px-4 py-1.5 text-[12px] font-black rounded-md transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  style={days === opt.value ? {
                    background: 'linear-gradient(125deg, rgb(var(--accent)), rgb(var(--accent-2)))',
                    color: '#fff',
                    boxShadow: '0 2px 8px -2px rgb(var(--accent) / 0.5)',
                  } : { color: 'rgb(var(--muted))' }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Post limit */}
          <div className="space-y-2">
            <p className="text-[10px] text-muted uppercase tracking-widest font-bold">Post Limit</p>
            <input type="number" min="0" value={limit} disabled={running}
              onChange={e => setLimit(e.target.value)}
              placeholder="unlimited"
              className="w-28 bg-surface/80 border border-line/60 rounded-xl px-3 py-[7px] text-ink text-sm placeholder:text-faint focus:ring-2 focus:ring-accent/30 focus:border-accent/60 outline-none transition-all disabled:opacity-50" />
          </div>

          {/* Browser mode */}
          <div className="space-y-2">
            <p className="text-[10px] text-muted uppercase tracking-widest font-bold">Browser</p>
            <button onClick={() => setVisible(v => !v)} disabled={running}
              className="flex items-center gap-2 px-4 py-[7px] text-[12px] font-bold rounded-xl border transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={visible ? {
                border: '1px solid rgb(var(--accent) / 0.5)',
                background: 'rgb(var(--accent) / 0.1)',
                color: 'rgb(var(--accent))',
              } : {
                border: '1px solid rgb(var(--line) / 0.6)',
                color: 'rgb(var(--muted))',
              }}>
              <span className="material-symbols-outlined text-[16px]">{visible ? 'visibility' : 'visibility_off'}</span>
              {visible ? 'Visible' : 'Headless'}
            </button>
          </div>

          <div className="flex-1" />

          {/* Stop button — only when running */}
          {running && (
            <button onClick={stop} disabled={stopping}
              className="flex items-center gap-2 px-6 py-2.5 rounded-xl font-black text-sm uppercase tracking-widest border transition-all duration-200 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              style={{
                border: '1px solid rgb(var(--danger) / 0.5)',
                color:  'rgb(var(--danger))',
                background: 'rgb(var(--danger) / 0.08)',
                boxShadow:  stopping ? 'none' : '0 4px 16px -4px rgb(var(--danger) / 0.3)',
              }}>
              {stopping
                ? <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                : <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>stop_circle</span>}
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}

          {/* Run button */}
          <button onClick={run} disabled={running || launching}
            className="relative gradient-accent text-white px-8 py-2.5 rounded-xl font-black text-sm uppercase tracking-widest flex items-center gap-2.5 transition-all duration-200 hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer overflow-hidden"
            style={{ boxShadow: (running || launching) ? 'none' : 'var(--shadow-accent)' }}>
            {(running || launching)
              ? <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              : <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>bolt</span>}
            {running ? 'Pipeline Running…' : launching ? 'Starting…' : 'Run Pipeline'}
          </button>
        </div>

        {/* Last-run args */}
        {status?.args && Object.keys(status.args).length > 0 && (
          <div className="mt-4 pt-4 border-t border-line/30 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-faint uppercase tracking-wider font-bold">
              {hasSa ? `Session started ${status.started_at?.replace('T', ' ')}  ·` : 'Last args:'}
            </span>
            {[
              `--days ${status.args.days || 1}`,
              status.args.limit > 0 ? `--limit ${status.args.limit}` : null,
              status.args.visible   ? '--visible' : null,
            ].filter(Boolean).map(a => (
              <span key={a} className="text-[10px] px-2 py-0.5 rounded-md bg-surface-2 text-muted font-mono">{a}</span>
            ))}
          </div>
        )}
      </div>

      {/* ── DAG Stage Flow ── */}
      <div className="card rounded-2xl p-6 fade-up-2">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>account_tree</span>
            </div>
            <h3 className="text-sm font-bold text-ink">Stage Flow</h3>
          </div>
          <div className="flex items-center gap-3">
            {hasSa && (
              <span className="text-[10px] text-faint">session vs all-time shown per metric</span>
            )}
            {running && (
              <span className="text-[10px] px-3 py-1 rounded-full font-black uppercase tracking-widest"
                style={{
                  background: 'rgb(var(--warning) / 0.15)',
                  color: 'rgb(var(--warning))',
                  animation: 'jh-pulse-glow 2s ease-in-out infinite',
                }}>
                ● Live · auto-refresh 10s
              </span>
            )}
          </div>
        </div>

        <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
          {STAGES.map((stage, i) => (
            <div key={stage.id} className="flex items-center gap-1 flex-1 min-w-0">
              <StageNode
                stage={stage}
                state={stateMap[stage.id]}
                metrics={stageMetrics(stage.id, status)}
              />
              {i < STAGES.length - 1 && (
                <FlowEdge fromState={stateMap[stage.id]} />
              )}
            </div>
          ))}
        </div>

        <p className="mt-5 text-[10px] text-center" style={{ color: 'rgb(var(--faint))' }}>
          All 4 stages start simultaneously — Scrape feeds Extract → Filter → Score in real-time as batches arrive
        </p>
      </div>

      {/* ── Run Log ── */}
      <div className="card rounded-2xl p-6 fade-up-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>terminal</span>
            </div>
            <h3 className="text-sm font-bold text-ink">Run Log</h3>
          </div>
          <div className="flex items-center gap-3">
            {running && (
              <span className="flex items-center gap-1.5 text-[10px] font-bold" style={{ color: 'rgb(var(--warning))' }}>
                <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                Live
              </span>
            )}
            {log.length > 0 && <span className="text-[10px]" style={{ color: 'rgb(var(--faint))' }}>{log.length} lines</span>}
          </div>
        </div>

        <div ref={logRef}
          className="rounded-xl p-4 h-72 overflow-y-auto custom-scrollbar font-mono text-[11px] leading-[1.65]"
          style={{ background: 'rgb(var(--bg) / 0.9)', border: '1px solid rgb(var(--line) / 0.4)' }}>
          {log.length === 0 ? (
            <p style={{ color: 'rgb(var(--faint))' }}>No log yet — run the pipeline to see output here.</p>
          ) : (
            log.map((line, i) => (
              <div key={i} style={{ color: logColor(line) }}>{line || ' '}</div>
            ))
          )}
        </div>
      </div>

    </div>
  )
}
