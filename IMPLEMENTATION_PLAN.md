# Implementation plan (this pass)

Order follows the brief's priorities: correctness, security, concurrency, performance, reliability, accessibility, polish.
"Model" is the model that did the work. The main conversation runs on whatever the user selects with `/model`; it was
Opus for this pass. Switches are not claimed unless they happened.

| # | Phase | Acceptance criteria | Verification | Model |
| --- | --- | --- | --- | --- |
| 1 | Security: 128-bit codes, `409` for a reused key, key scoped to user + endpoint, CSRF origin check | tests prove each; old behaviour fails them | `npm test` | Opus |
| 2 | Transactional outbox: events written in the change's transaction, published after commit, monotonic ids that survive restarts, replay from the database, unpublished events relayed at boot | SSE tests for replay across a restart and for a crash between commit and publish | `npm test` | Opus |
| 3 | 100-user race in the suite; `invite.regenerated` event | database inspected after the race | `npm test` | Opus |
| 4 | Profiling: `Server-Timing` (db, app), fast-path latency in the histogram, `PERFORMANCE_AUDIT.md` with evidence | headers present; audit cites measurements | curl, `/metrics`, load test | Opus |
| 5 | Board Lighthouse: profile, then fix the measured cause | board 90+ locally; deployed result reported as measured | Lighthouse desktop + mobile, reports saved | Opus |
| 6 | Load tests at 10/50/100 connections: local, regional, remote reports | three report files from real runs | `npm run loadtest` | Opus |
| 7 | Optimistic rollback demonstrated | browser test asserts optimistic state, then rollback on `409` | `npm run test:e2e` | Opus |
| 8 | Deploy and re-verify live; docs; video | live race, browser test and load test re-run | scripts above against the live URL | Opus |

Risks: the outbox adds one write per mutation (latency, measured after); Render free instances sleep and have a fraction
of a CPU; Docker cannot be verified on this machine; a regional client in Singapore is not available, so "regional" is
measured server-side (in-process timing under the remote load) and labelled as such.
