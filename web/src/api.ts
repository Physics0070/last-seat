export type User = { id: string; email: string; displayName: string; skills: string[]; timezone: string }
export type Person = Omit<User, 'email'>
export type Hackathon = { id: string; slug: string; name: string; minTeamSize: number; maxTeamSize: number }
export type Meta = { skills: string[]; hackathon: Hackathon }
export type Team = {
  id: string
  name: string
  description: string
  lookingFor: string[]
  leaderId: string
  memberCount: number
  minSize: number
  maxSize: number
  openSeats: number
  status: 'forming' | 'formed'
  createdAt: string
}
export type Member = Person & { joinedAt: string; isLeader: boolean }
export type JoinRequest = { id: string; teamId: string; userId: string; message: string; status: string; createdAt: string; user?: Person }
export type Invite = { code: string; expiresAt: string }
export type MyState = { teamId: string | null; pendingRequests: JoinRequest[] }
export type Breakdown = { skill: number; timezone: number; newSkills: string[]; wantedSkills: string[]; overlapHours: number }
export type Suggestion<T> = T & { score: number; breakdown: Breakdown }
export type AuditEntry = { id: string; action: string; actorId: string; targetId: string | null; before: unknown; after: unknown; requestId: string; at: string }
export type LiveEvent = { type: string; teamId?: string; userId?: string; requestId?: string; team?: Team }

export class ApiError extends Error {
  status: number
  code: string
  details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Message safe to show a person, whatever was thrown. */
export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection and try again.'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const mutating = method !== 'GET'
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: {
      ...(mutating && { 'Content-Type': 'application/json' }),
      // One key per user action. If the network drops we retry with the same key, so the server
      // replays the first outcome instead of joining twice or creating a second team.
      ...(mutating && { 'Idempotency-Key': crypto.randomUUID() }),
    },
    body: mutating ? JSON.stringify(body ?? {}) : undefined,
  }
  let res: Response
  try {
    res = await fetch(`/api${path}`, init)
  } catch (err) {
    if (!mutating) throw err
    res = await fetch(`/api${path}`, init)
  }
  // A busy server (503) did not store anything under this key, so asking again with the same key is safe.
  for (let attempt = 0; attempt < 4 && res.status === 503 && mutating; attempt++) {
    await new Promise((r) => setTimeout(r, Number(res.headers.get('Retry-After') ?? 1) * 1000))
    res = await fetch(`/api${path}`, init)
  }
  if (res.status === 409 && mutating) {
    const peek = await res.clone().json()
    // Our own first attempt is still running on the server: wait as told, then ask again with the same key.
    if (peek.error?.code === 'idempotency_in_progress') {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('Retry-After') ?? 1) * 1000))
      res = await fetch(`/api${path}`, init)
    }
  }
  const data = await res.json()
  if (!res.ok) throw new ApiError(res.status, data.error.code, data.error.message, data.error.details)
  return data as T
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body),
  del: <T,>(path: string) => request<T>('DELETE', path),
}
