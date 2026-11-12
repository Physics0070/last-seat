import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError, errorMessage, type Invite, type Suggestion, type Team } from './api'
import { useApp } from './app'
import { SkillPicker } from './Public'

type Page = { items: Team[]; nextCursor: string | null }
type TeamSuggestion = Suggestion<{ team: Team }>
const FULL_LINGER_MS = 4000

export function Board() {
  const { meta, user, my, refreshMy, onLive, announce } = useApp()
  const hid = meta.hackathon.id
  const navigate = useNavigate()
  const [skill, setSkill] = useState('')
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [requested, setRequested] = useState<Set<string>>(new Set())
  const [cardError, setCardError] = useState<{ teamId: string; message: string } | null>(null)
  const [lost, setLost] = useState<TeamSuggestion[] | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      setPage(await api.get<Page>(`/hackathons/${hid}/teams${skill ? `?skill=${skill}` : ''}`))
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [hid, skill])
  useEffect(() => {
    setPage(null)
    void load()
  }, [load])

  // Apply live events to the list in place: no refetch, no flicker.
  useEffect(
    () =>
      onLive((e) => {
        if (e.type === 'reset') return void load()
        if (e.type === 'team.deleted') {
          setPage((p) => p && { ...p, items: p.items.filter((t) => t.id !== e.teamId) })
          return
        }
        const team = e.team
        if (!team) return
        if (e.type === 'team.created') announce(`New team: ${team.name}.`)
        else if (team.openSeats === 0) announce(`${team.name} is now full.`)
        else if (e.type === 'member.joined') announce(`${team.name} now has ${team.memberCount} of ${team.maxSize} members${team.openSeats === 1 ? '. One seat left' : ''}.`)

        setPage((p) => {
          if (!p) return p
          const known = p.items.some((t) => t.id === team.id)
          if (known) return { ...p, items: p.items.map((t) => (t.id === team.id ? team : t)) }
          const matches = team.openSeats > 0 && (!skill || team.lookingFor.includes(skill))
          // Only insert teams that belong on the part of the list already loaded (ids sort by creation time).
          const inRange = !p.nextCursor || p.items.length === 0 || team.id > p.items[p.items.length - 1].id
          if (!matches || !inRange) return p
          return { ...p, items: [...p.items, team].sort((a, b) => (a.id < b.id ? 1 : -1)) }
        })
        // A team that just filled stays visible for a moment as "Full", then leaves the board.
        if (team.openSeats === 0) {
          setTimeout(() => setPage((p) => p && { ...p, items: p.items.filter((t) => t.id !== team.id || t.openSeats > 0) }), FULL_LINGER_MS)
        }
      }),
    [onLive, load, announce, skill],
  )

  async function loadMore() {
    if (!page?.nextCursor) return
    setLoadingMore(true)
    try {
      const next = await api.get<Page>(`/hackathons/${hid}/teams?cursor=${page.nextCursor}${skill ? `&skill=${skill}` : ''}`)
      setPage((p) => p && { items: [...p.items, ...next.items.filter((n) => !p.items.some((t) => t.id === n.id))], nextCursor: next.nextCursor })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  /** Losing a race is normal here: say so kindly and offer the next best teams. */
  async function showNextBest() {
    const { suggestions } = await api.get<{ suggestions: TeamSuggestion[] }>(`/hackathons/${hid}/suggestions?kind=teams`)
    setLost(suggestions.slice(0, 3))
  }

  async function requestToJoin(team: Team) {
    // Optimistic: show "Requested" at once, roll back if the server says no.
    setRequested((s) => new Set(s).add(team.id))
    setCardError(null)
    try {
      await api.post(`/teams/${team.id}/requests`, {})
      announce(`Request sent to ${team.name}.`)
      await refreshMy()
    } catch (err) {
      setRequested((s) => {
        const next = new Set(s)
        next.delete(team.id)
        return next
      })
      setCardError({ teamId: team.id, message: errorMessage(err) })
      if (err instanceof ApiError && err.code === 'team_full') await showNextBest().catch(() => undefined)
    }
  }

  const pending = new Set([...requested, ...my.pendingRequests.map((r) => r.teamId)])
  const canAct = !!user && !my.teamId

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Looking for teammates</h1>
          <p className="muted">Teams with a free seat, newest first. This list updates by itself.</p>
        </div>
        {canAct && <button className="btn primary" onClick={() => dialog.current?.showModal()}>Create a team</button>}
        {!user && <Link className="btn primary" to="/signup">Join to take a seat</Link>}
        {my.teamId && <Link className="btn" to={`/teams/${my.teamId}`}>Go to my team</Link>}
      </div>

      <div className="toolbar">
        {canAct && <RedeemForm onJoined={(team) => navigate(`/teams/${team.id}`)} onFull={showNextBest} />}
        <label className="inline">
          Wanted skill
          <select value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">Any</option>
            {meta.skills.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
      </div>

      {lost && (
        <section className="card lost" aria-labelledby="lost-title">
          <span className="fading-star" aria-hidden="true" />
          <h2 id="lost-title" tabIndex={-1} ref={(el) => el?.focus()}>That seat was taken a moment ago</h2>
          <p>Someone reached it first. Nothing is wrong on your side. {lost.length ? 'These teams fit you best right now:' : 'No other open teams match yet. Create your own?'}</p>
          <ul className="plain">
            {lost.map((s) => (
              <li key={s.team.id} className="row">
                <span>
                  <Link to={`/teams/${s.team.id}`}>{s.team.name}</Link>{' '}
                  <span className="muted">{Math.round(s.score * 100)}% match{s.breakdown.newSkills.length ? `, you add ${s.breakdown.newSkills.join(', ')}` : ''}</span>
                </span>
                <button className="btn small" disabled={pending.has(s.team.id)} onClick={() => requestToJoin(s.team)}>
                  {pending.has(s.team.id) ? 'Requested' : 'Request to join'}
                </button>
              </li>
            ))}
          </ul>
          <button className="btn ghost small" onClick={() => setLost(null)}>Dismiss</button>
        </section>
      )}

      {error && (
        <div className="card" role="alert">
          <p className="error">{error}</p>
          <button className="btn" onClick={load}>Try again</button>
        </div>
      )}
      {!page && !error && <ul className="team-list" aria-busy="true" aria-label="Loading teams">{[0, 1, 2].map((i) => <li key={i} className="card skeleton" />)}</ul>}
      {page && page.items.length === 0 && (
        <div className="card empty">
          <h2>No open teams{skill ? ` looking for ${skill}` : ''} yet</h2>
          <p className="muted">{canAct ? 'Be the first light in the sky: create a team.' : 'New teams appear here the moment they are created.'}</p>
        </div>
      )}
      {page && page.items.length > 0 && (
        <ul className="team-list">
          {page.items.map((team) => (
            <li key={team.id} className={`card team${team.openSeats === 1 ? ' last-seat' : ''}${team.openSeats === 0 ? ' full' : ''}`}>
              <div className="team-top">
                <h2><Link to={`/teams/${team.id}`}>{team.name}</Link></h2>
                <Seats team={team} />
              </div>
              {team.description && <p>{team.description}</p>}
              <div className="team-bottom">
                <div className="chips" aria-label="Looking for">
                  <span className={`chip ${team.status}`}>{team.status === 'formed' ? 'Formed' : `Forming, needs ${team.minSize - team.memberCount} more`}</span>
                  {team.lookingFor.map((s) => <span key={s} className="chip">{s}</span>)}
                </div>
                {canAct && team.openSeats > 0 && (
                  <button className="btn small" disabled={pending.has(team.id)} onClick={() => requestToJoin(team)}>
                    {pending.has(team.id) ? 'Requested' : 'Request to join'}<span className="sr-only"> {team.name}</span>
                  </button>
                )}
              </div>
              {cardError?.teamId === team.id && <p role="alert" className="error">{cardError.message}</p>}
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor && <button className="btn center" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show more teams'}</button>}

      <CreateTeamDialog dialogRef={dialog} />
    </>
  )
}

export function Seats({ team }: { team: Team }) {
  return (
    <span className="seats">
      <span aria-hidden="true" className="seat-dots">
        {Array.from({ length: team.maxSize }, (_, i) => <span key={i} className={i < team.memberCount ? 'dot on' : 'dot'} />)}
      </span>
      <span className="seat-text">
        {team.memberCount}/{team.maxSize}
        <span className="sr-only"> members</span>
        {team.openSeats === 1 && <strong className="badge">Last seat</strong>}
        {team.openSeats === 0 && <strong className="badge">Full</strong>}
      </span>
    </span>
  )
}

function RedeemForm({ onJoined, onFull }: { onJoined: (team: Team) => void; onFull: () => Promise<void> }) {
  const { refreshMy, announce } = useApp()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const code = new FormData(e.currentTarget).get('code')
    setBusy(true)
    setError('')
    try {
      const { team } = await api.post<{ team: Team }>('/invites/redeem', { code })
      announce(`You joined ${team.name}.`)
      await refreshMy()
      onJoined(team)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'team_full') await onFull().catch(() => setError(errorMessage(err)))
      else setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="redeem" onSubmit={submit}>
      <label htmlFor="code">Have an invite code?</label>
      <div className="row">
        <input id="code" name="code" required placeholder="A1B2-C3D4-E5F6-A7B8-C9D0" autoComplete="off" spellCheck={false} aria-describedby={error ? 'code-error' : undefined} />
        <button className="btn" disabled={busy}>{busy ? 'Joining…' : 'Join instantly'}</button>
      </div>
      {error && <p id="code-error" role="alert" className="error">{error}</p>}
    </form>
  )
}

function CreateTeamDialog({ dialogRef }: { dialogRef: React.RefObject<HTMLDialogElement | null> }) {
  const { meta, refreshMy } = useApp()
  const navigate = useNavigate()
  const [lookingFor, setLookingFor] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      const created = await api.post<{ team: Team; invite: Invite }>(`/hackathons/${meta.hackathon.id}/teams`, {
        name: form.get('name'),
        description: form.get('description'),
        lookingFor,
      })
      await refreshMy()
      // The invite code is shown once, on the team page; only its hash is stored on the server.
      navigate(`/teams/${created.team.id}`, { state: { invite: created.invite } })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  // A native <dialog>: focus trap, Escape to close and focus return come from the browser.
  return (
    <dialog ref={dialogRef} aria-labelledby="create-title">
      <form className="form" onSubmit={submit}>
        <h2 id="create-title">Create a team</h2>
        <label>
          Team name
          <input name="name" required minLength={2} maxLength={60} autoFocus />
        </label>
        <label>
          What are you building? <span className="hint">Optional</span>
          <textarea name="description" maxLength={500} rows={3} />
        </label>
        <SkillPicker legend="Skills you are looking for" options={meta.skills} value={lookingFor} onChange={setLookingFor} />
        {error && <p role="alert" className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create team'}</button>
        </div>
      </form>
    </dialog>
  )
}
