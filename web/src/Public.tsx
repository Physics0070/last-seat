import { m, useMotionValueEvent, useScroll, useSpring, useTransform } from 'motion/react'
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, errorMessage, type User } from './api'
import { useApp } from './app'

export function Landing() {
  const { user, meta, reducedMotion } = useApp()
  const { minTeamSize, maxTeamSize, name } = meta.hackathon
  // Everything on this page is driven by scroll position. With reduced motion none of it is applied:
  // the same content is simply laid out, visible, in order.
  const { scrollY, scrollYProgress } = useScroll()
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 30 })
  const heroOpacity = useTransform(scrollY, [0, 520], [1, 0])
  const heroY = useTransform(scrollY, [0, 520], [0, -90])
  const heroScale = useTransform(scrollY, [0, 520], [1, 0.93])
  const join = user ? '/board' : '/signup'

  return (
    <div className="landing">
      {!reducedMotion && <m.div className="scroll-progress" style={{ scaleX: progress }} aria-hidden="true" />}

      <m.section className="hero" style={reducedMotion ? undefined : { opacity: heroOpacity, y: heroY, scale: heroScale }}>
        <p className="eyebrow">{name}</p>
        <h1>Find your team before the last seat is gone.</h1>
        <p className="lede">
          Ten thousand people, one night sky. Every point of light is someone looking for a team of {minTeamSize} to {maxTeamSize}.
        </p>
        <div className="actions">
          <Link className="btn primary large" to={join}>{user ? 'Open the board' : 'Join the hackathon'}</Link>
          <Link className="btn ghost large" to="/board">Watch teams form live</Link>
        </div>
        <p className="scroll-cue" aria-hidden="true">Scroll</p>
      </m.section>

      <Beat index={0} title="Alone, you are a point of light.">
        <p>Say what you are good at and where in the world you are. That is all the board needs to start matching you.</p>
      </Beat>
      <Beat index={1} title="Together, you are a constellation.">
        <p>Paste an invite code and you are in instantly. Or ask a team from the board and let its leader say yes. Everyone watching sees it happen as it happens.</p>
      </Beat>

      <SeatScene seats={maxTeamSize} />

      <Beat index={2} title="The last seat belongs to exactly one person.">
        <p>When fifty people reach for it in the same instant, one gets it and forty-nine are told so, immediately and honestly, with the next best teams to try.</p>
        <div className="actions">
          <Link className="btn primary large" to={join}>{user ? 'Find a team' : 'Take your seat'}</Link>
        </div>
      </Beat>
    </div>
  )
}

/** One story section. It slides in from its side as it climbs the viewport, with a large numeral drifting behind it. */
function Beat({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  const { reducedMotion } = useApp()
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress: arriving } = useScroll({ target: ref, offset: ['start 0.95', 'start 0.5'] })
  const { scrollYProgress: passing } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const x = useTransform(arriving, [0, 1], [index % 2 ? 90 : -90, 0])
  const y = useTransform(arriving, [0, 1], [70, 0])
  const numeralY = useTransform(passing, [0, 1], [140, -140])
  return (
    <section ref={ref} className="beat">
      <m.span className="beat-number" aria-hidden="true" style={reducedMotion ? undefined : { y: numeralY }}>0{index + 1}</m.span>
      <m.div className="beat-body" style={reducedMotion ? undefined : { opacity: arriving, x, y }}>
        <h2>{title}</h2>
        {children}
      </m.div>
    </section>
  )
}

/**
 * A pinned scene: the page holds still while scrolling fills a team's seats one at a time,
 * ending on the last seat. The text carries the story; the dots are decoration.
 */
function SeatScene({ seats }: { seats: number }) {
  const { reducedMotion } = useApp()
  const ref = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const [filled, setFilled] = useState(1)
  useMotionValueEvent(scrollYProgress, 'change', (v) => setFilled(Math.min(seats, 1 + Math.floor(v * seats))))

  const shown = reducedMotion ? seats : filled
  const line =
    shown >= seats ? 'Taken. Exactly once.' : shown === seats - 1 ? 'One seat left. Fifty people are looking at it.' : 'A team starts with one person and an idea.'
  return (
    <section ref={ref} className={`scene${reducedMotion ? ' still' : ''}`} style={reducedMotion ? undefined : { height: `${seats * 55 + 100}vh` }}>
      <div className="scene-pin">
        <div className={`scene-seats${shown === seats - 1 ? ' last' : ''}`} aria-hidden="true">
          {Array.from({ length: seats }, (_, i) => <span key={i} className={i < shown ? 'big-seat on' : 'big-seat'} />)}
        </div>
        <p className="scene-count">{shown} of {seats} seats taken</p>
        <h2>{line}</h2>
      </div>
    </section>
  )
}

export function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const { meta, setUser } = useApp()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/board'
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), [])
  const [skills, setSkills] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const signup = mode === 'signup'

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    if (signup && skills.length === 0) return setError('Pick at least one skill.')
    setBusy(true)
    setError('')
    try {
      const body = signup
        ? { email: form.get('email'), password: form.get('password'), displayName: form.get('displayName'), timezone: form.get('timezone'), skills }
        : { email: form.get('email'), password: form.get('password') }
      const { user } = await api.post<{ user: User }>(`/auth/${mode}`, body)
      setUser(user)
      navigate(from, { replace: true })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="narrow">
      <h1>{signup ? 'Create your account' : 'Welcome back'}</h1>
      <form className="card form" onSubmit={submit} aria-describedby={error ? 'auth-error' : undefined}>
        {signup && (
          <label>
            Display name
            <input name="displayName" required maxLength={60} autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required minLength={signup ? 8 : 1} autoComplete={signup ? 'new-password' : 'current-password'} aria-describedby={signup ? 'pw-hint' : undefined} />
          {signup && <span id="pw-hint" className="hint">At least 8 characters.</span>}
        </label>
        {signup && (
          <>
            <label>
              Time zone
              <select name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} required>
                {zones.map((z) => <option key={z}>{z}</option>)}
              </select>
            </label>
            <SkillPicker legend="Your skills (up to 8)" options={meta.skills} value={skills} onChange={setSkills} />
          </>
        )}
        {error && <p id="auth-error" role="alert" className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? 'One moment…' : signup ? 'Create account' : 'Log in'}</button>
      </form>
      <p className="muted">
        {signup ? <>Already have an account? <Link to="/login">Log in</Link></> : <>New here? <Link to="/signup">Create an account</Link></>}
      </p>
    </div>
  )
}

export function SkillPicker({ legend, options, value, onChange, max = 8 }: { legend: string; options: string[]; value: string[]; onChange: (v: string[]) => void; max?: number }) {
  return (
    <fieldset className="chips-field">
      <legend>{legend}</legend>
      <div className="chips">
        {options.map((s) => {
          const checked = value.includes(s)
          return (
            <label key={s} className={`chip toggle${checked ? ' on' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && value.length >= max}
                onChange={() => onChange(checked ? value.filter((v) => v !== s) : [...value, s])}
              />
              {s}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function NotFound() {
  return (
    <div className="narrow">
      <h1>Nothing here</h1>
      <p>That page does not exist. <Link to="/board">Go to the board</Link>.</p>
    </div>
  )
}
