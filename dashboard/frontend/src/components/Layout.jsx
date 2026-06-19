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
      { to: '/pipeline',  icon: 'account_tree',    label: 'Pipeline' },
      { to: '/jobs',      icon: 'work',            label: 'Jobs' },
      { to: '/applied',   icon: 'fact_check',      label: 'Applied Analysis' },
      { to: '/outreach',  icon: 'outgoing_mail',   label: 'Outreach' },
      { to: '/recruiters',icon: 'contact_page',    label: 'Recruiters' },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: '/profile-fields', icon: 'assignment_late', label: 'Profile Fields' },
      { to: '/raw-data',       icon: 'database',         label: 'Raw Posts' },
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

  const running = pipeline?.running

  return (
    <div className="overflow-x-hidden min-h-screen">
      {/* Sidebar */}
      <aside className="h-screen w-64 fixed left-0 top-0 overflow-y-auto custom-scrollbar flex flex-col z-50
        bg-surface/75 dark:bg-[rgb(6_8_22/0.85)] backdrop-blur-2xl border-r border-line/60">
        {/* Subtle gradient sheen down the sidebar */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgb(var(--accent)/0.04) 0%, transparent 40%, rgb(var(--accent-2)/0.03) 100%)' }} />

        {/* Brand */}
        <div className="relative px-5 py-6 flex items-center gap-3">
          <div className="relative shrink-0">
            <div className="w-11 h-11 rounded-2xl gradient-accent flex items-center justify-center shrink-0"
              style={{ boxShadow: '0 0 0 4px rgb(var(--accent)/0.12), 0 8px 24px -6px rgb(var(--accent)/0.5)' }}>
              <span className="material-symbols-outlined text-white text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>travel_explore</span>
            </div>
            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-surface" />
          </div>
          <div>
            <h1 className="text-[17px] font-extrabold leading-5 tracking-tight shimmer-text">Job Hunter</h1>
            <p className="text-[9px] uppercase tracking-[0.18em] text-faint font-bold mt-0.5">AI Career Intelligence</p>
          </div>
        </div>

        <div className="neon-line mx-5 mb-4 opacity-60" />

        <nav className="relative flex-1 px-3 space-y-5">
          {NAV_GROUPS.map(group => (
            <div key={group.label}>
              <p className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-faint/80">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      'group relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200 ' +
                      (isActive
                        ? 'text-white font-semibold'
                        : 'text-muted hover:bg-surface-2/80 hover:text-ink')
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute inset-0 rounded-xl gradient-accent opacity-90"
                            style={{ boxShadow: '0 4px 16px -4px rgb(var(--accent)/0.5)' }} aria-hidden="true" />
                        )}
                        <span className={`relative material-symbols-outlined text-[20px] transition-transform group-hover:scale-110 ${isActive ? 'text-white' : ''}`}
                          style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}>{item.icon}</span>
                        <span className="relative">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="neon-line mx-5 mb-3 opacity-40" />

        <div className="px-3 pb-5">
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium text-muted hover:bg-surface-2/80 hover:text-ink transition-all duration-200 cursor-pointer group"
          >
            <span className="material-symbols-outlined text-[20px] transition-transform group-hover:rotate-12">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>

      {/* Top bar */}
      <header className="flex items-center gap-4 ml-64 px-8 py-3 bg-bg/80 backdrop-blur-2xl sticky top-0 z-40"
        style={{ borderBottom: '1px solid rgb(var(--line)/0.5)', boxShadow: '0 1px 0 rgb(var(--accent)/0.06)' }}>
        <div className="relative w-full max-w-md group">
          <span className="absolute inset-y-0 left-3 flex items-center text-faint pointer-events-none transition-colors duration-200 group-focus-within:text-accent">
            <span className="material-symbols-outlined text-[19px]">search</span>
          </span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleSearch}
            className="w-full bg-surface/90 border border-line/60 rounded-xl pl-10 pr-4 py-2 text-ink text-sm placeholder:text-faint focus:ring-2 focus:ring-accent/30 focus:border-accent/60 outline-none transition-all duration-200 focus:shadow-lg focus:shadow-accent/10"
            placeholder="Search jobs, companies, recruiters…  ⏎"
            type="text"
            aria-label="Search jobs, companies, recruiters"
          />
        </div>
        {/* Pipeline status chip — links to pipeline page */}
        {pipeline && (
          <a href="/pipeline"
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-line/50 text-xs font-semibold text-muted hover:border-accent/30 hover:text-ink transition-all duration-200 shrink-0 cursor-pointer"
            style={{ textDecoration: 'none' }}>
            <span className="relative flex h-2 w-2 shrink-0">
              {running && <span className="absolute inset-0 rounded-full bg-warning opacity-70 animate-ping" />}
              <span className="relative h-2 w-2 rounded-full"
                style={{
                  background: running ? 'rgb(var(--warning))' : 'rgb(var(--success))',
                  boxShadow: running ? '0 0 6px rgb(var(--warning))' : '0 0 5px rgb(var(--success))',
                }} />
            </span>
            {running ? 'Running…' : 'Pipeline'}
          </a>
        )}
      </header>

      {/* Main content */}
      <main className="ml-64 p-8 min-h-screen max-w-[1440px]">
        {children}
      </main>
    </div>
  )
}
