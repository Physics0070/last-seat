# Project state

Updated 2026-11-14, at the end of the "master prompt" pass. Every line below was verified by running something, not by
reading code. The gaps table from the start of the pass is kept at the bottom, with what happened to each one.

## Working and verified
- **Domain rules:**
  - min/max team size, and one team per person (a unique index);
  - expiring, hashed, **128-bit** invite codes, with regeneration (which emits `invite.regenerated`, never the code);
  - join requests, with leader-only accept, decline and remove;
  - leadership passes to the longest-standing member, and the last member out deletes the team.
  - Covered in `test/rules.test.js`.
- **Race-proof seat claim:**
  - a conditional `findOneAndUpdate` inside a transaction, together with the membership, audit, idempotency and outbox
    writes;
  - a 50-way race (5 rounds) and a **100-way race checked in the database**, both in the suite;
  - live on 2026-11-14, 100 racers: exactly 1 winner and 4/4 members, with no server errors.
- **Idempotency:**
  - keys are scoped to user, method and path;
  - a reused key with a different body answers `409 idempotency_key_reused`;
  - the success response is stored in the change's own transaction;
  - the chaos test kills the real server mid-burst.
- **Real time:**
  - a transactional outbox with monotonic sequence numbers;
  - `Last-Event-ID` replay from memory or from the outbox, which survives a restart;
  - unstamped events are relayed at boot;
  - clients drop duplicates by `eventId`.
- **Security:**
  - argon2id passwords; an httpOnly, SameSite=Lax cookie;
  - a CSRF check: writes whose `Origin` host differs from `Host` get `403`;
  - zod schemas, per-address and per-user limits, and a proxy depth measured on Render.
- **Observability:** request ids, structured logs, `GET /metrics` (including fast-path hits and event-loop delay), and
  `Server-Timing` (`db`, `ser`, `cache`, `txn`, `app`) on every API response.
- **Performance:** see [PERFORMANCE_AUDIT.md](PERFORMANCE_AUDIT.md).
  - The board no longer loads the animation library: the main chunk is 270.6 KB, down from 346.7 KB.
  - The live-update stream opens after load.
  - The board's layout shift is fixed: CLS 0.651 → 0.
  - Lighthouse live (median of 5): landing 100 desktop / 91 mobile, board 96 / 86; accessibility 100 everywhere.
- **Load:** 10/50/100 users, paced and flat out, locally and live
  ([LOAD_TEST_REMOTE.md](LOAD_TEST_REMOTE.md), [LOAD_TEST_REGIONAL.md](LOAD_TEST_REGIONAL.md)). 0 failed requests.
  Live paced p95 is 143 ms at 50 users and 145 ms at 100.
- **UI:**
  - React, phone layouts, four palettes, and a lazy 3D sky;
  - a keyboard-only flow, and an optimistic "Request to join" that rolls back, both asserted by the browser test
    (which fails when the rollback is removed).
- **Tests:** 87 in `npm test`, plus `scripts/e2e.js` against a running app.
- **Deployed:** https://last-seat-sg.onrender.com (Render free, Singapore) with Atlas M0 (India).

## Still open
| Item | Status |
| --- | --- |
| `docker compose up` end to end | not run: Docker Desktop's engine will not start on this machine. The compose file validates. |
| Atlas seed data | the live board shows only test teams; `npm run seed` must be re-run with `MONGODB_URI` set in the owner's own shell |
| Old Oregon service (`last-seat-erqy`) | still running; it should be suspended or deleted in the Render dashboard |
| Regional client | there is no load generator in Singapore; the regional report is server-side timing |
| Board on mobile | Lighthouse median 86 (target 90+). What is left is React's first render, about 280 ms at 4× CPU; three attempts to cut it were measured and reverted |
| Video | the idempotency scene still says `422`, and codes are now 128 bits; a re-render is needed |

## Gaps at the start of the pass, and what happened
| Gap | Now |
| --- | --- |
| Invite codes were 80 bits | 128 bits (`INVITE_CODE_BYTES=16`), tested |
| A reused key with a different body answered `422` | `409`, keys scoped to user and endpoint, tested |
| No CSRF defence beyond SameSite=Lax | Origin check on writes, tested |
| No transactional outbox; replay lost on restart | outbox and durable replay, restart and boot-relay tests |
| No "invite regenerated" event | emitted, without the code |
| No 100-user race in the suite | `test/races.test.js` |
| No Server-Timing or performance audit | both, see [PERFORMANCE_AUDIT.md](PERFORMANCE_AUDIT.md) |
| Board Lighthouse 78–80 | live board 96 on desktop and 86 on mobile (median of 5); mobile still under 90 |
| Load reports only at 100 connections | 10/50/100, local, remote and regional (server-side) |
| Optimistic rollback untested | browser test, with a negative control |
| `docker compose up` not run | still not run (see above) |
