import { useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api, errorMessage, type User } from './api'
import { useApp } from './app'

export function Landing() {
  const { user, meta } = useApp()
  const { minTeamSize, maxTeamSize, name } = meta.hackathon
  return (
    <div className="landing">
      <section className="hero">
        <p className="eyebrow">{name}</p>
        <h1>Find your team before the last seat is gone.</h1>
        <p className="lede">
          Ten thousand people, one night sky. Every point of light is someone looking for a team of {minTeamSize} to {maxTeamSize}.
        </p>
        <div className="actions">
          <Link className="btn primary large" to={user ? '/board' : '/signup'}>{user ? 'Open the board' : 'Join the hackathon'}</Link>
          <Link className="btn ghost large" to="/board">Watch teams form live</Link>
        </div>
      </section>

      <section className="beat">
        <h2>Alone, you are a point of light.</h2>
        <p>Say what you are good at and where in the world you are. That is all the board needs to start matching you.</p>
      </section>
      <section className="beat">
        <h2>Together, you are a constellation.</h2>
        <p>Paste an invite code and you are in instantly. Or ask a team from the board and let its leader say yes. Everyone watching sees it happen as it happens.</p>
      </section>
      <section className="beat">
        <h2>The last seat belongs to exactly one person.</h2>
        <p>When fifty people reach for it in the same instant, one gets it and forty-nine are told so, immediately and honestly, with the next best teams to try.</p>
        <div className="actions">
          <Link className="btn primary large" to={user ? '/board' : '/signup'}>{user ? 'Find a team' : 'Take your seat'}</Link>
        </div>
      </section>
    </div>
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
