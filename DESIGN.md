# Design: The Last Seat

Node 20 + Express 5, MongoDB (replica set), React. One process serves the API, the live event stream and the UI.
Long version: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Numbers: [LOAD_TEST.md](LOAD_TEST.md).

## Data model
`users` (email unique, argon2id hash, skills, timezone) · `hackathons` · `teams` (leader, `memberCount`, `minSize`/`maxSize` copied at creation, `isOpen`, **hashed** invite code + expiry) · `memberships` (**unique `(hackathonId, userId)`**) · `joinRequests` (partial unique on pending `(team, user)`) · `auditLog` (append-only, written in the same transaction, with request id) · `idempotencyKeys` (`_id = userId:key`). The board is served by one index, `(hackathonId, isOpen, _id)`, with a cursor: 21 keys examined per page, no sort, no skip.

## How races are prevented
1. **The seat is one atomic update:** `findOneAndUpdate({ _id, $expr: memberCount < maxSize }, memberCount + 1)`. Two requests cannot both pass the check for the last seat.
2. **It runs in a transaction** with the membership insert and the audit entry, so a person who is already on a team (the unique index says no) releases the seat they just took. Write conflicts retry with bounded, jittered backoff; the loser re-reads, sees a full team, and gets a clean `409`.
3. **The database holds the invariants,** not the application: one team per person is a unique index.
4. **Leader leaves** → the longest-standing member leads; **last member leaves** → the team, its code and its pending requests go in the same transaction.

**Proof:** 50 people, one seat, 5 rounds over real HTTP: one `200`, 49 `409`. With the guard line deleted, 40 win, so the test bites. Also 250-way (one winner), double-click, two teams at once, two accepts for one seat, leader leaving mid-join. **Chaos:** the real server is `SIGKILL`ed mid-burst, restarted, every request retried; nothing corrupted, doubled or lost.

## Idempotency
Every mutating request takes `Idempotency-Key`. The first request inserts `userId:key` (the unique `_id` is the lock); duplicates replay the stored response, a different body gets `422`, a request still running gets `409` + `Retry-After`. The response is stored **inside the change's own transaction**, so a crash right after the commit still replays the original success on retry (the chaos test shows 16 such cases; without this, those retries fail).

## Real time
Server-sent events with ids `<boot>-<seq>`, a replay ring buffer and `Last-Event-ID`; if the gap cannot be proven the server sends `reset` and clients refetch. 10,000 open connections held at ~34 KB each; one event reached all in under a second.

## Trade-offs
- **Single instance.** The event bus, rate-limit counters and board cache live in process memory. Scale-out: Redis streams + `rate-limit-redis`.
- **A cached board** (1 s TTL, cleared on every change) answered before any middleware: it is why p95 is 145 ms locally, and why board reads are not rate limited.
- **Brute-force limits count wrong guesses,** not requests: 80-bit codes are not guessable, and a crowd pressing join on one valid code from one venue connection must get clean `409`s, not throttling.
- **A hard kill** leaves the dead server's transactions holding locks until MongoDB expires them (60 s): those teams answer `503` + `Retry-After`, never corrupt data; the UI retries with the same key.
- **Suggestions score everyone without a team in memory** (shared pool, a few ms at 10k users); past ~100k, pre-filter by an index.
- **Region mattered more than code.** With the server in Oregon and the database in India (~240 ms apart) a join took 2.1 s and a 50-way race 7-10 s; next to the database it is 0.5 s and 1-4 s, same code. Live p95 on the board is still ~420 ms at 100 users (free tier, ~190 ms network floor), so the 200 ms target is met locally only.

## With one more week
Redis for events, limits and cache invalidation so more than one instance is correct · in-transaction idempotency for signup/login · k6 from a separate machine against a paid instance · Playwright for the UI in CI · notifications to a requester on accept/decline · per-team backpressure so a hot team cannot starve the retry budget.
