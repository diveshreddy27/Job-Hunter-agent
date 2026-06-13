import { useState, useEffect, useRef, useCallback } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'

const NAV_GROUPS = [
  {
    label: 'Analyze',
    items: [
      { to: '/',          icon: 'space_dashboard', label: 'Overview' },
      { to: '/analytics', icon: 'monitoring',      label: 'Market Insights' },
      { to: '/skills-gap',icon: 'psychology',      label: 'Skills Gap' },
    ],
  },
  {
    label: 'Act',
    items: [
      { to: '/jobs',      icon: 'work',            label: 'Jobs' },
      { to: '/tracker',   icon: 'fact_check',      label: 'Application Tracker' },
      { to: '/outreach',  icon: 'outgoing_mail',   label: 'Outreach' },
      { to: '/recruiters',icon: 'contact_page',    label: 'Recruiters' },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: '/raw-data',  icon: 'database',        label: 'Raw Posts' },
    ],
  },
]

function getTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export default function Layout({ children }) {
  const [theme, setTheme] = useState(getTheme)
  const [pipeline, setPipeline] = useState(null)
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const pollRef = useRef(null)

  const fetchStatus = useCallback(() => {
    fetch('/api/pipeline-status')
      .then(r => r.json())
      .then(d => {
        setPipeline(d)
        // Poll fast while a run is active, otherwise relax
        clearTimeout(pollRef.current)
        pollRef.current = setTimeout(fetchStatus, d.running ? 5000 : 60000)
      })
      .catch(() => {
        clearTimeout(pollRef.current)
        pollRef.current = setTimeout(fetchStatus, 30000)
      })
  }, [])

  useEffect(() => {
    fetchStatus()
    return () => clearTimeout(pollRef.current)
  }, [fetchStatus])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem('jh-theme', next)
    setTheme(next)
  }

  function handleSearch(e) {
    if (e.key === 'Enter' && search.trim()) {
      navigate('/jobs?q=' + encodeURIComponent(search.trim()))
      setSearch('')
    }
  }

  function runPipeline() {
    fetch('/api/run-pipeline', { method: 'POST' })
      .then(r => r.json())
      .then(() => fetchStatus())
      .catch(() => {})
  }

  const running = pipeline?.running
  const backlog = (pipeline?.pending_extraction || 0) + (pipeline?.unscored_targets || 0)

  return (
    <div className="overflow-x-hidden min-h-screen">
      {/* Sidebar */}
      <aside className="h-screen w-64 fixed left-0 top-0 overflow-y-auto custom-scrollbar flex flex-col z-50
        bg-surface/70 backdrop-blur-xl border-r border-line">
        <div className="px-5 py-6 flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl gradient-accent flex items-center justify-center glow-accent shrink-0">
            <span className="material-symbols-outlined text-white text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>travel_explore</span>
          </div>
          <div>
            <h1 className="text-[17px] font-extrabold leading-5 tracking-tight gradient-text">Job Hunter</h1>
            <p className="text-[9px] uppercase tracking-[0.18em] text-faint font-bold mt-0.5">AI Career Intelligence</p>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-5 mt-1">
          {NAV_GROUPS.map(group => (
            <div key={group.label}>
              <p className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-faint">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      'group relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 ' +
                      (isActive
                        ? 'bg-accent/12 text-accent font-semibold shadow-sm shadow-accent/10'
                        : 'text-muted hover:bg-surface-2 hover:text-ink')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-full gradient-accent" aria-hidden="true" />}
                        <span className="material-symbols-outlined text-[20px] transition-transform group-hover:scale-110"
                          style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}>{item.icon}</span>
                        {item.label}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Pipeline status panel */}
        <div className="mx-3 mb-3 p-3.5 rounded-2xl bg-surface-2/70 border border-line backdrop-blur">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="relative flex h-2.5 w-2.5">
              {running && <span className="absolute inline-flex h-full w-full rounded-full bg-warning opacity-60 animate-ping" />}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${running ? 'bg-warning' : 'bg-success'}`} />
            </span>
            <p className="text-[11px] font-bold text-ink">{running ? 'Pipeline running…' : 'Agent idle'}</p>
          </div>
          <p className="text-[10px] text-muted leading-4">
            Last run: {pipeline?.last_run || '—'}
            {backlog > 0 && <><br /><span className="text-warning font-semibold">{backlog} item{backlog > 1 ? 's' : ''}</span> in backlog</>}
          </p>
        </div>

        <div className="px-3 pb-5 border-t border-line pt-3">
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-ink transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px]">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>

      {/* Top bar */}
      <header className="flex justify-between items-center gap-4 ml-64 px-8 py-3.5 bg-bg/70 backdrop-blur-xl border-b border-line/80 sticky top-0 z-40">
        <div className="relative w-full max-w-sm group">
          <span className="absolute inset-y-0 left-3 flex items-center text-faint pointer-events-none transition-colors group-focus-within:text-accent">
            <span className="material-symbols-outlined text-[19px]">search</span>
          </span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleSearch}
            className="w-full bg-surface/80 border border-line rounded-xl pl-10 pr-4 py-2 text-ink text-sm placeholder:text-faint focus:ring-2 focus:ring-accent/40 focus:border-accent outline-none transition-shadow focus:shadow-lg focus:shadow-accent/10"
            placeholder="Search jobs, companies, recruiters…  ⏎"
            type="text"
            aria-label="Search jobs, companies, recruiters"
          />
        </div>
        <button
          onClick={runPipeline}
          disabled={running}
          className="gradient-accent text-white pl-4 pr-5 py-2 rounded-xl font-bold text-xs uppercase tracking-wide hover:brightness-110 active:scale-95 transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 shrink-0 glow-accent cursor-pointer"
        >
          {running
            ? <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
            : <span className="material-symbols-outlined text-[18px]">bolt</span>}
          {running ? 'Running…' : 'Run Pipeline'}
        </button>
      </header>

      {/* Main content */}
      <main className="ml-64 p-8 min-h-screen max-w-[1440px]">
        {children}
      </main>
    </div>
  )
}
