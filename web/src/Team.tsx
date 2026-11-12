import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, errorMessage, type AuditEntry, type Invite, type JoinRequest, type Member, type Person, type Suggestion, type Team } from './api'
import { useApp, useRequireUser } from './app'
import { Seats } from './Board'

type Detail = { team: Team; members: Member[]; inviteExpiresAt: string }
type PersonSuggestion = Suggestion<{ user: Person }>

export function TeamPage() {
  const user = useRequireUser()
  const { id } = useParams() as { id: string }
  const { my, refreshMy, onLive, announce, meta } = useApp()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [requests, setRequests] = useState<JoinRequest[]>([])
  const [error, setError] = useState('')
  const [gone, setGone] = useState(false)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')
  const [invite, setInvite] = useState<Invite | null>((useLocation().state as { invite?: Invite } | null)?.invite ?? null)
  const [copied, setCopied] = useState(false)

  const isLeader = !!user && detail?.team.leaderId === user.id
  const isMember = !!user && !!detail?.members.some((m) => m.id === user.id)

  const load = useCallback(async () => {
    try {
      const next = await api.get<Detail>(`/teams/${id}`)
      setDetail(next)
      setError('')
      if (user && next.team.leaderId === user.id) setRequests((await api.get<{ requests: JoinRequest[] }>(`/teams/${id}/requests`)).requests)
      else setRequests([])
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone(true)
      else setError(errorMessage(err))
    }
  }, [id, user])
  useEffect(() => void (user && load()), [load, user])

  useEffect(
    () =>
      onLive((e) => {
        if (e.type !== 'reset' && e.teamId !== id) return
        if (e.type === 'team.deleted') return setGone(true)
        if (e.type === 'member.joined') announce('A new member joined the team.')
        else if (e.type === 'member.left' || e.type === 'member.removed') announce('A member left the team.')
        else if (e.type === 'leader.changed') announce('The team has a new leader.')
        else if (e.type === 'request.created') announce('New request to join.')
        void load()
      }),
    [onLive, id, load, announce],
  )

  /** Runs one action; shows its error in place and re-syncs from the server either way. */
  async function act(name: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(name)
    setActionError('')
    try {
      await fn()
      if (done) announce(done)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy('')
      await Promise.all([load(), refreshMy()]).catch(() => undefined)
    }
  }

  async function decide(request: JoinRequest, action: 'accept' | 'decline') {
    // Optimistic: the request leaves the inbox at once. If the server refuses (seat gone, already handled), load() puts the truth back.
    setRequests((rs) => rs.filter((r) => r.id !== request.id))
    await act(`${action}-${request.id}`, () => api.post(`/requests/${request.id}/${action}`), `${request.user?.displayName} ${action === 'accept' ? 'accepted' : 'declined'}.`)
  }

  async function copy() {
    if (!invite) return
    await navigator.clipboard.writeText(invite.code)
    setCopied(true)
    announce('Invite code copied.')
  }

  if (!user) return null
  if (gone) {
    return (
      <div className="narrow">
        <h1>This team no longer exists</h1>
        <p>Its last member left, so the team and its invite code are gone.</p>
        <Link className="btn primary" to="/board">Back to the board</Link>
      </div>
    )
  }
  if (error) {
    return (
      <div className="narrow" role="alert">
        <h1>Could not load this team</h1>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>Try again</button>
      </div>
    )
  }
  if (!detail) return <div className="card skeleton tall" aria-busy="true" aria-label="Loading team" />

  const { team, members } = detail
  const myRequest = my.pendingRequests.find((r) => r.teamId === id)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{team.name}</h1>
          <p className="muted">
            {team.status === 'formed' ? 'Formed' : `Forming: needs ${team.minSize - team.memberCount} more to reach the minimum of ${team.minSize}`}
          </p>
        </div>
        <Seats team={team} />
      </div>
      {actionError && <p role="alert" className="card error">{actionError}</p>}

      <div className="team-grid">
        <section className="card" aria-labelledby="members-title">
          <Constellation members={members} maxSize={team.maxSize} />
          <h2 id="members-title">Members</h2>
          {team.description && <p>{team.description}</p>}
          <ul className="plain members">
            {members.map((m) => (
              <li key={m.id} className="row">
                <span>
                  <strong>{m.displayName}</strong>{m.id === user.id && ' (you)'} {m.isLeader && <span className="badge">Leader</span>}
                  <span className="muted block">{m.skills.join(', ')} · {m.timezone}</span>
                </span>
                {isLeader && !m.isLeader && (
                  <button
                    className="btn small danger"
                    disabled={!!busy}
                    onClick={() => window.confirm(`Remove ${m.displayName} from the team?`) && act(`remove-${m.id}`, () => api.del(`/teams/${id}/members/${m.id}`), `${m.displayName} removed.`)}
                  >
                    Remove<span className="sr-only"> {m.displayName}</span>
                  </button>
                )}
              </li>
            ))}
            {Array.from({ length: team.openSeats }, (_, i) => <li key={i} className="row muted">Open seat</li>)}
          </ul>

          {isMember && (
            <button
              className="btn danger"
              disabled={!!busy}
              onClick={() => {
                const warning = members.length === 1 ? 'You are the last member, so the team will be deleted.' : isLeader ? 'Leadership passes to the longest-standing member.' : ''
                if (!window.confirm(`Leave ${team.name}? ${warning}`)) return
                void act('leave', async () => {
                  await api.post(`/teams/${id}/leave`)
                  await refreshMy()
                  navigate('/board')
                })
              }}
            >
              Leave team
            </button>
          )}
          {!isMember && !my.teamId && team.openSeats > 0 && (
            myRequest ? (
              <button className="btn" disabled={!!busy} onClick={() => act('cancel', () => api.post(`/requests/${myRequest.id}/cancel`), 'Request cancelled.')}>Cancel my request</button>
            ) : (
              <button className="btn primary" disabled={!!busy} onClick={() => act('request', () => api.post(`/teams/${id}/requests`, {}), 'Request sent.')}>Request to join</button>
            )
          )}
        </section>

        {isLeader && (
          <div className="stack">
            <section className="card" aria-labelledby="inbox-title">
              <h2 id="inbox-title">Requests to join <span className="count">{requests.length}</span></h2>
              {requests.length === 0 ? (
                <p className="muted">No pending requests. New ones appear here live.</p>
              ) : (
                <ul className="plain">
                  {requests.map((r) => (
                    <li key={r.id} className="row request">
                      <span>
                        <strong>{r.user?.displayName}</strong>
                        <span className="muted block">{r.user?.skills.join(', ')} · {r.user?.timezone}</span>
                        {r.message && <span className="block">“{r.message}”</span>}
                      </span>
                      <span className="row">
                        <button className="btn small primary" disabled={!!busy || team.openSeats === 0} onClick={() => decide(r, 'accept')}>Accept<span className="sr-only"> {r.user?.displayName}</span></button>
                        <button className="btn small" disabled={!!busy} onClick={() => decide(r, 'decline')}>Decline<span className="sr-only"> {r.user?.displayName}</span></button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="invite-title">
              <h2 id="invite-title">Invite code</h2>
              {invite ? (
                <>
                  <p>Anyone with this code joins instantly while a seat is free. It is shown only now; we keep just a hash.</p>
                  <div className="row">
                    <code className="code">{invite.code}</code>
                    <button className="btn small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <p className="muted">Expires {new Date(invite.expiresAt).toLocaleString()}.</p>
                </>
              ) : (
                <p className="muted">The current code expires {new Date(detail.inviteExpiresAt).toLocaleString()}. Lost it? Generate a new one; the old one stops working.</p>
              )}
              <button
                className="btn"
                disabled={!!busy}
                onClick={() => act('invite', async () => {
                  setInvite((await api.post<{ invite: Invite }>(`/teams/${id}/invite`)).invite)
                  setCopied(false)
                }, 'New invite code generated.')}
              >
                Generate new code
              </button>
            </section>

            {team.openSeats > 0 && <PeopleSuggestions hackathonId={meta.hackathon.id} version={members.length} />}
            <AuditLog teamId={id} version={`${members.length}-${requests.length}-${team.leaderId}`} />
          </div>
        )}
      </div>
    </>
  )
}

/** The team drawn as a constellation. Decorative: the member list below carries the same information. */
function Constellation({ members, maxSize }: { members: Member[]; maxSize: number }) {
  const point = (i: number) => {
    const angle = (i / maxSize) * Math.PI * 2 - Math.PI / 2
    return { x: 100 + Math.cos(angle) * 62, y: 80 + Math.sin(angle) * 52 }
  }
  const leader = Math.max(0, members.findIndex((m) => m.isLeader))
  return (
    <svg className="constellation" viewBox="0 0 200 160" aria-hidden="true">
      {members.map((m, i) => i !== leader && <line key={m.id} x1={point(leader).x} y1={point(leader).y} x2={point(i).x} y2={point(i).y} />)}
      {Array.from({ length: maxSize }, (_, i) => {
        const m = members[i]
        return <circle key={m?.id ?? `seat-${i}`} cx={point(i).x} cy={point(i).y} r={m ? (m.isLeader ? 7 : 5) : 4} className={m ? (m.isLeader ? 'star leader' : 'star') : 'open'} />
      })}
    </svg>
  )
}

function PeopleSuggestions({ hackathonId, version }: { hackathonId: string; version: number }) {
  const [state, setState] = useState<{ items?: PersonSuggestion[]; error?: string }>({})
  useEffect(() => {
    api.get<{ suggestions: PersonSuggestion[] }>(`/hackathons/${hackathonId}/suggestions`).then(
      (r) => setState({ items: r.suggestions.slice(0, 5) }),
      (err) => setState({ error: errorMessage(err) }),
    )
  }, [hackathonId, version])

  return (
    <section className="card" aria-labelledby="suggest-title">
      <h2 id="suggest-title">People who would complete this team</h2>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {!state.items && !state.error && <p className="muted" aria-busy="true">Finding people…</p>}
      {state.items?.length === 0 && <p className="muted">Everyone is on a team already.</p>}
      <ul className="plain">
        {state.items?.map((s) => (
          <li key={s.user.id} className="row">
            <span>
              <strong>{s.user.displayName}</strong>
              <span className="muted block">
                {s.breakdown.newSkills.length ? `Adds ${s.breakdown.newSkills.join(', ')}` : 'No new skills'} · {s.breakdown.overlapHours}h of shared working day
              </span>
            </span>
            <span className="score" title={`skills ${Math.round(s.breakdown.skill * 100)}%, time zone ${Math.round(s.breakdown.timezone * 100)}%`}>{Math.round(s.score * 100)}%<span className="sr-only"> match</span></span>
          </li>
        ))}
      </ul>
      {!!state.items?.length && <p className="muted">Share your invite code with them. Score = skills you lack (60%) + time-zone overlap (40%).</p>}
    </section>
  )
}

const ACTION_LABELS: Record<string, string> = {
  'team.created': 'created the team',
  'team.deleted': 'deleted the team',
  'member.joined_by_invite': 'joined with an invite code',
  'member.left': 'left the team',
  'member.removed': 'was removed',
  'leader.changed': 'became leader',
  'request.created': 'asked to join',
  'request.accepted': 'was accepted',
  'request.declined': 'was declined',
  'request.cancelled': 'cancelled their request',
  'invite.regenerated': 'generated a new invite code',
}

function AuditLog({ teamId, version }: { teamId: string; version: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ items?: AuditEntry[]; error?: string }>({})
  useEffect(() => {
    if (!open) return
    api.get<{ items: AuditEntry[] }>(`/teams/${teamId}/audit?limit=50`).then(
      (r) => setState({ items: r.items }),
      (err) => setState({ error: errorMessage(err) }),
    )
  }, [open, teamId, version])

  return (
    <details className="card" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Team history</summary>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {!state.items && !state.error && <p className="muted" aria-busy="true">Loading history…</p>}
      <ol className="plain audit">
        {state.items?.map((e) => (
          <li key={e.id}>
            <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
            <span>User …{(e.targetId ?? e.actorId).slice(-6)} {ACTION_LABELS[e.action] ?? e.action}{e.targetId && e.targetId !== e.actorId ? ` (by …${e.actorId.slice(-6)})` : ''}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}
