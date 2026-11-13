# Architecture (the long version)

The one-page summary is [DESIGN.md](../DESIGN.md); this file is the detail behind it.

Race-proof team formation for a hackathon with 10,000 participants. Node 20+, Express 5, MongoDB (replica set), React.

## Invariants, and what enforces each

| Invariant | Enforced by | Proved by |
| --- | --- | --- |
| A team never exceeds its max size | One conditional update: `findOneAndUpdate({ _id, $expr: memberCount < maxSize }, memberCount + 1)` (`claimSeat` in `src/teams.js`) | `races.test.js`: 50 users, one seat, 5 rounds |
| One team per person per hackathon | Unique index `memberships(hackathonId, userId)` | `rules.test.js` inserts a second membership directly and gets E11000 |
| `memberCount` equals the number of membership rows | Seat claim, membership insert and audit entry commit in one transaction | every race test compares the two |
| The leader is always a member | Leave/remove rewrites the team document in the same transaction as the membership delete | "leader leaves while two people join" |
| One pending request per (team, user) | Partial unique index on `joinRequests` where `status = 'pending'` | `rules.test.js` |
| A retried request never acts twice | Idempotency record with `_id = userId:key`, plus the indexes above | `idempotency.test.js` |

**Negative control.** With the `$expr` guard deleted from `claimSeat`, the 50-user test fails with 40 winners. The test detects the bug it exists for.

## Data model

- `users`: email (unique), argon2id hash, displayName, skills[], timezone, utcOffsetMinutes.
- `hackathons`: slug (unique), name, minTeamSize, maxTeamSize. One, created from env at startup.
- `teams`: hackathonId, name, description, lookingFor[], leaderId, memberCount, minSize, maxSize, isOpen, inviteCodeHash (unique), inviteExpiresAt. Size limits are copied from the hackathon at creation. `isOpen` is recomputed inside the same update that changes `memberCount`.
- `memberships`: hackathonId, teamId, userId, joinedAt.
- `joinRequests`: hackathonId, teamId, userId, message, status (pending/accepted/declined/cancelled).
- `auditLog`: append-only. actorId, action, teamId, targetId, before, after, requestId, at.
- `idempotencyKeys`: `_id = userId:key`, fingerprint, state, status, body, TTL index.

The invite code lives on the team document (one active code per team), so deleting the team deletes the code in the same write.

## How races are prevented

**Why a conditional update *and* a transaction.** They solve different problems. The conditional update makes "check there is room, then take it" a single atomic step, so two requests cannot both pass the check. The transaction makes "take the seat, insert the membership, write the audit entry" all-or-nothing: if the membership insert fails (the person is already on another team), the seat is released.

**What happens when 50 requests collide.** MongoDB does not queue writers. The first transaction to write the team document proceeds; the others fail at once with a write conflict, labelled transient. `withTxn` (`src/db.js`) retries those with jittered backoff, up to `TXN_MAX_ATTEMPTS`. On retry they read the winner's committed state, the guard no longer matches, and they return `409 team_full`. If retries run out the answer is `503`, never a wrong write.

**Leaving, removing, deleting.** Every one of these writes the team document, which is what serialises them against joins. Leader transfer picks the member with the oldest `joinedAt`. When the last member leaves, the team is deleted and its pending requests cancelled in the same transaction.

**Accepting a request.** The claim filter includes `leaderId = actor`, so an accept racing a leadership change cannot succeed for the old leader.

Events are published only after commit, so a retried transaction cannot emit twice.

## Idempotency

Every mutating endpoint accepts `Idempotency-Key`. The record's `_id` is `userId:key` (`anon:key` for signup and login), so the `_id` index is the lock.

- First request inserts the record as `processing` and runs.
- Same key and same request, finished: the stored status and body are replayed with `Idempotency-Replayed: true`. Client errors (4xx) are stored too; 5xx is not.
- Same key, different method/path/body: `422`.
- Same key while the first is still running: `409` with `Retry-After`.
- The lock expires after `IDEMPOTENCY_LOCK_SECONDS`, so a crashed request does not block its key.

**The commit/response gap is closed.** For team changes, `withTxn` writes the successful response into the idempotency record **inside the same transaction** as the change (the key travels through `AsyncLocalStorage`, so domain functions do not carry it). Change and stored answer commit together or not at all. A crash after the commit therefore leaves a retry that replays the original success, never a confusing `409 already_on_team` for something that worked. Failures (4xx) are stored after the handler, which is safe because they are deterministic given the state. `5xx` is never stored.

**Proof, not argument.** `test/chaos.test.js` starts the real server as a separate process, fires 90 concurrent joins with keys, `SIGKILL`s it the instant new memberships appear in the database (the commit-to-response window), restarts it on the same database and retries everything with the same keys. It asserts: every retry succeeds, exactly leaders + joiners memberships exist, nobody is on two teams, every team is exactly full with a matching counter, and exactly one audit row exists per join. In one run, 16 joins had committed but were never answered; all 16 were replayed as their original success. With the in-transaction write disabled, the same test fails (retries get `already_on_team`).

**What a hard kill costs.** MongoDB keeps a dead client's open transactions alive until its transaction lifetime limit (60 s by default), and they hold locks on the documents they touched. During that time, writes to those teams answer `503 busy` with `Retry-After`. Nothing is corrupted and nothing is stored under the key, so clients retry with the same key (the UI does, up to four times). The test lowers the limit to 3 s so it runs in seconds.

Signup and login bodies contain a password, so the request fingerprint is an HMAC keyed with `JWT_SECRET`, not a plain hash. A replayed signup or login also re-issues the session cookie, which is not part of the stored body. Those two complete their record after the handler; a retry after a crash gets `409 email_taken` for signup (the unique email index is the safety net).

## Real time

Server-sent events on `GET /api/hackathons/:id/events`. Each event has id `<bootId>-<seq>`. The browser's `EventSource` reconnects by itself and sends `Last-Event-ID`; the server replays newer events from a ring buffer (`SSE_REPLAY_BUFFER`). If the id comes from an earlier process or has left the buffer, the server sends `reset` and the client refetches. Request events carry the team id but not who asked.

**Limitation.** The bus, the replay buffer, the rate-limit counters and the board cache are in process memory. This is correct for exactly one instance. To scale out: publish events through Redis Streams (the stream id becomes the event id), use `rate-limit-redis`, and clear the board cache from the same stream.

## Security

- JWT in an `httpOnly`, `SameSite=Lax` cookie; argon2id password hashes; login compares against a dummy hash for unknown emails.
- Leader-only actions are checked on the server, inside the transaction where it matters.
- Invite codes: 80 bits from `crypto.randomBytes`, stored as SHA-256, expiring. Redemption is rate-limited per IP and per user. Unknown and expired codes return the same response.
- Every body, query and param goes through a strict zod schema (unknown fields rejected). One error shape, no stack traces. All configuration is validated at startup with no in-code defaults.

## Suggestions

`GET /api/hackathons/:id/suggestions` ranks people without a team for the caller's team (`?kind=teams` ranks open teams for a person, used after losing a race).

```
skill    = min(1, points / SUGGEST_SKILL_TARGET)
           points = skills the person has that nobody on the team has,
                    counted twice if the team listed them in lookingFor
timezone = mean over team members of max(0, WORKDAY - hoursApart) / WORKDAY
           hoursApart = circular distance between UTC offsets (0 to 12)
score    = (wSkill * skill + wTz * timezone) / (wSkill + wTz)
```

Defaults: weights 0.6 and 0.4, target 3 skills, 8-hour workday. Each result carries its breakdown.

## Operations

- `GET /metrics` (Prometheus text, aggregate only): request duration histogram by route template and status, transaction retries and failures, error counts by code (`team_full`, `forbidden`, ...), idempotent replays, board fast-path hits, open live connections, memory, uptime.
- Request ids tie a log line, an API response (`X-Request-Id`) and an audit entry together.
- `npm run test:e2e`, `npm run loadtest` and `npm run capacity` (see [LOAD_TEST.md](../LOAD_TEST.md)).

## Performance

The board query is `{ hackathonId, isOpen: true }` sorted by `_id` descending with an `_id` cursor, served by the index `(hackathonId, isOpen, _id)`: 21 keys examined for a page of 20, no sort stage, no skip. Serialized pages are cached in memory, shared by concurrent readers, and cleared on every team change. `LOAD_TEST.md` has the numbers with the cache on and off, and how the first run failed.

## Where it bends (measured, one Node process, laptop)

| Probe | Result |
| --- | --- |
| 250 people racing for one seat | exactly 1 winner, 249 clean 409, 1.5 s, no 5xx |
| 10,000 open live connections | held at about 31 KB each; one event reached all 10,000 in 0.38 s |
| Board, 10,000 users / 2,000 teams | 1,650 req/s cached, 420 req/s uncached |
| Signups | 12/s with argon2 library defaults, 49/s with the OWASP-minimum parameters now used (300 signups, 64 in flight) |
| Suggestions | was 12 req/s, p50 1.5 s, 809 MB peak (it reloaded every user per request); now 103 req/s, p50 158 ms, 391 MB peak, from a shared pool invalidated on every change |

Not measured: a multi-instance deployment, sustained mixed write load, Atlas M0's operation and connection caps, the free Render instance (a fraction of a CPU, 512 MB, sleeps when idle).

## Trade-offs taken

- One hackathon from env rather than an admin API. The schema carries `hackathonId` everywhere, so adding more is additive.
- Plain JavaScript on the server (no build step), TypeScript in the UI. zod validates at every boundary.
- UTC offset is captured at signup, so it drifts an hour across daylight-saving changes.
- Suggestions score every user in memory (a few ms at 10k users). Past roughly 100k, pre-filter by a skills index.
- The 3D sky is a single `Points` draw call with a shader, not react-three-fiber: one dependency instead of three, and it does not touch React's render path.

## With one more week

1. Move the event bus, rate limits and cache invalidation to Redis so more than one instance is correct.
2. Give signup and login the same in-transaction idempotency record.
3. Playwright tests for the UI, including two browsers racing for one seat.
4. Notifications to the requester on accept/decline, and profile editing.
5. Load test from a separate machine against the deployed stack.
