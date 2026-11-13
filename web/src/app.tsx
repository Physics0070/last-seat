import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LazyMotion, MotionConfig } from 'motion/react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, type LiveEvent, type Meta, type MyState, type User } from './api'
import { Sky } from './Sky'

type Listener = (event: LiveEvent) => void
type AppState = {
  meta: Meta
  user: User | null
  setUser: (user: User | null) => void
  my: MyState
  refreshMy: () => Promise<void>
  /** Subscribe to live team events; returns the unsubscribe function. `reset` means "refetch, you may have missed some". */
  onLive: (listener: Listener) => () => void
  /** Speak a message to screen readers (and show it in the status bar). */
  announce: (message: string) => void
  reducedMotion: boolean
}

const AppContext = createContext<AppState | null>(null)
export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp outside AppProvider')
  return ctx
}

const loadMotion = () => import('./motionFeatures').then((m) => m.default)
const NO_STATE: MyState = { teamId: null, pendingRequests: [] }
const MOTION_KEY = 'motion'
const THEME_KEY = 'theme'
const THEMES = { aurora: 'Aurora', midnight: 'Midnight gold', nebula: 'Nebula', ember: 'Ember' } as const
type Theme = keyof typeof THEMES

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<{ meta: Meta; user: User | null } | null>(null)
  const [bootError, setBootError] = useState(false)
  const [my, setMy] = useState<MyState>(NO_STATE)
  const [status, setStatus] = useState('')
  const [live, setLive] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const systemReduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const [reducedMotion, setReducedMotion] = useState(() => (localStorage.getItem(MOTION_KEY) ?? (systemReduced ? 'reduced' : 'full')) === 'reduced')
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return saved && saved in THEMES ? (saved as Theme) : 'aurora'
  })
  const listeners = useRef(new Set<Listener>())

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? 'reduced' : 'full'
  }, [reducedMotion])

  const load = useCallback(async () => {
    setBootError(false)
    try {
      const [meta, me] = await Promise.all([
        api.get<Meta>('/meta'),
        api.get<{ user: User | null }>('/me'),
      ])
      setBoot({ meta, user: me.user })
    } catch {
      setBootError(true)
    }
  }, [])
  useEffect(() => void load(), [load])

  const hackathonId = boot?.meta.hackathon.id
  const userId = boot?.user?.id
  const refreshMy = useCallback(async () => {
    if (!hackathonId || !userId) return setMy(NO_STATE)
    setMy(await api.get<MyState>(`/hackathons/${hackathonId}/me`))
  }, [hackathonId, userId])
  useEffect(() => {
    refreshMy().catch(() => setMy(NO_STATE))
  }, [refreshMy])

  // One EventSource for the whole app. The browser reconnects by itself and sends Last-Event-ID,
  // so the server replays what was missed; if it cannot, it sends `reset` and every view refetches.
  useEffect(() => {
    if (!hackathonId) return
    const source = new EventSource(`/api/hackathons/${hackathonId}/events`)
    const emit = (event: LiveEvent) => listeners.current.forEach((l) => l(event))
    source.onopen = () => setLive('live')
    source.onerror = () => setLive('reconnecting')
    source.onmessage = (e) => emit(JSON.parse(e.data))
    source.addEventListener('reset', () => emit({ type: 'reset' }))
    return () => source.close()
  }, [hackathonId])

  const onLive = useCallback((listener: Listener) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  const announce = useCallback((message: string) => setStatus(message), [])
  const setUser = useCallback((user: User | null) => setBoot((b) => b && { ...b, user }), [])

  // Keep "my team / my requests" current when something that concerns this user happens.
  useEffect(
    () =>
      onLive((e) => {
        if (e.type === 'reset' || e.type.startsWith('request.') || e.userId === userId || e.type === 'team.deleted') {
          refreshMy().catch(() => undefined)
        }
      }),
    [onLive, refreshMy, userId],
  )

  if (bootError) {
    return (
      <main className="center-screen">
        <h1>We could not reach the server</h1>
        <p>It may be starting up. Give it a few seconds.</p>
        <button className="btn primary" onClick={load}>Try again</button>
      </main>
    )
  }
  if (!boot) return <main className="center-screen" aria-busy="true"><p className="muted">Loading…</p></main>

  const value: AppState = { meta: boot.meta, user: boot.user, setUser, my, refreshMy, onLive, announce, reducedMotion }
  return (
    <AppContext.Provider value={value}>
      <LazyMotion features={loadMotion} strict>
        <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>{children}</MotionConfig>
      </LazyMotion>
      <div className="statusbar">
        <span className={`live-dot ${live}`} aria-hidden="true" />
        <span className="muted live-word">{live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
        {/* Every live change is announced here for screen-reader users. */}
        <span role="status" aria-live="polite" className="status-text">{status}</span>
        <label className="theme-picker">
          <span>Colours</span>
          <select
            aria-label="Colour palette"
            value={theme}
            onChange={(e) => {
              localStorage.setItem(THEME_KEY, e.target.value)
              setTheme(e.target.value as Theme)
            }}
          >
            {Object.entries(THEMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button
          className="btn ghost small"
          aria-pressed={reducedMotion}
          onClick={() => {
            localStorage.setItem(MOTION_KEY, reducedMotion ? 'full' : 'reduced')
            setReducedMotion(!reducedMotion)
          }}
        >
          Reduce motion
        </button>
      </div>
    </AppContext.Provider>
  )
}

export function Layout() {
  const { user, setUser, my, meta } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const main = useRef<HTMLElement>(null)

  // Focus management: after a route change, move focus to the new page so keyboard and screen-reader users land on it.
  // Compared against the previous path (not "is this the first run"), so the initial load leaves focus at the top of
  // the document, where the skip link is, even when React runs effects twice in development.
  const previousPath = useRef(location.pathname)
  useEffect(() => {
    if (previousPath.current === location.pathname) return
    previousPath.current = location.pathname
    main.current?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }, [location.pathname])

  async function logout() {
    await api.post('/auth/logout')
    setUser(null)
    navigate('/')
  }

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Sky />
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-star" aria-hidden="true" />
          The Last Seat
        </Link>
        <nav aria-label="Main">
          <NavLink to="/board">Board</NavLink>
          {my.teamId && <NavLink to={`/teams/${my.teamId}`}>My team</NavLink>}
          {user ? (
            <button className="btn ghost small" onClick={logout}>Log out<span className="sr-only"> ({user.displayName})</span></button>
          ) : (
            <NavLink to="/login">Log in</NavLink>
          )}
        </nav>
      </header>
      <main id="main" ref={main} tabIndex={-1} key={location.pathname} className="page">
        <Outlet />
      </main>
      <footer className="footer muted">{meta.hackathon.name} · teams of {meta.hackathon.minTeamSize}–{meta.hackathon.maxTeamSize}</footer>
    </>
  )
}

/** Redirects to the login page (and back afterwards) when there is no session. */
export function useRequireUser() {
  const { user } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    if (!user) navigate('/login', { replace: true, state: { from: location.pathname } })
  }, [user, navigate, location.pathname])
  return user
}
