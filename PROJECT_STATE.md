# Project state

Snapshot at the start of the "master prompt" pass. Every line below was verified by running something, not by reading code.

## Working and verified
- **Domain rules:** min/max size, one team per person (unique index), expiring hashed invite codes with regeneration, join requests with leader-only accept/decline/remove, leadership to the longest-standing member, last member out deletes the team and cancels its requests. Covered in `test/rules.test.js`.
- **Race-proof seat claim:** conditional `findOneAndUpdate` inside a transaction with the membership insert and the audit entry; bounded jittered retries on transient errors only. 50-way race (5 rounds) in the suite; live: 50-way and 100-way races gave exactly one winner and clean `409`s.
- **Idempotency:** every mutation; the success response is stored inside the change's own transaction. Concurrent duplicates and a crash are tested; `test/chaos.test.js` kills the real server mid-burst.
- **Real time:** SSE with event ids, an in-memory replay buffer, `reset` when the gap cannot be proven.
- **Security:** argon2id, httpOnly SameSite=Lax cookie, strict zod schemas, one error shape, per-address and per-user limits (invite limits count wrong guesses), proxy depth measured on Render.
- **Observability:** request ids, structured logs, `GET /metrics`.
- **Performance:** board index scan with cursor pagination, single-flight page cache answered before middleware. Local p95 4.6 ms at 100 connections.
- **UI:** React, phone layouts, keyboard-only flow verified in the browser test, four palettes, lazy 3D sky.
- **Deployed:** https://last-seat-sg.onrender.com (Render free, Singapore) with Atlas M0 (India). CI green.

## Gaps against the new brief (this pass)
| Gap | Why it matters |
| --- | --- |
| Invite codes are 80 bits | the brief asks for at least 128 |
| A reused Idempotency-Key with a different body answers `422` | the brief asks for `409`, and for endpoint scoping |
| No explicit CSRF defence beyond SameSite=Lax | defence in depth for cookie auth |
| Events are not in a transactional outbox; replay does not survive a restart | the brief requires an outbox and durable replay |
| "Invite regenerated" emits no event | it is in the brief's event list |
| No 100-user race in the automated suite | it is only a live script today |
| No `Server-Timing`, no `PERFORMANCE_AUDIT.md`; fast-path hits are not in the latency histogram | the brief requires profiling evidence before optimising |
| Board Lighthouse performance 78-80 | the brief targets 90+ |
| Load reports only at 100 connections; no regional report | the brief asks for 10/50/100 and local/regional/remote |
| Optimistic rollback is untested | bonus item must be demonstrated |
| `docker compose up` not run end to end | Docker Desktop's engine will not start on this machine |

## Known limits (documented, not hidden)
- Single instance: the event bus, rate-limit counters and caches are per process.
- Live board p95 misses 200 ms from the developer's laptop (about 186 ms of network before any work).
