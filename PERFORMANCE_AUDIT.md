# Performance audit

Profile first, change second, measure again. Every number here came from a command in this repository, and the raw
output is kept next to it. Where something did not improve, that is recorded too.

## Tools

| What | How |
| --- | --- |
| Lighthouse 13.6.0 | `bash scripts/lighthouse.sh <url> <label>`: landing and board, desktop preset and mobile emulation, **5 runs each, the median kept**. Reports: [docs/lighthouse/](docs/lighthouse/) |
| Main-thread traces | Lighthouse `--save-assets` traces, plus a Playwright `PerformanceObserver` for layout shifts |
| Bundle contents | `vite build --sourcemap`, bytes per package read from the source map |
| Server time | `Server-Timing` on every API response: `db`, `ser`, `cache`, `txn`, `app` |
| Load | `node scripts/loadsteps.js <url> <label>` at 10/50/100 users, paced and flat out. Raw: [docs/loadtest/](docs/loadtest/) |
| Metrics | `GET /metrics` (Prometheus): request histogram including fast-path hits, transaction retries, event-loop delay |

Why medians: single Lighthouse runs on this laptop varied widely. The same build of the board scored 100 and then 76
on desktop, and 72 to 89 across back-to-back mobile runs.

## Findings and changes

### 1. The board shipped the landing page's animation library

**Evidence.** The bundle source map showed Motion inside the main chunk, used on the board for card enter and exit.
A CDP trace with 4× CPU throttling showed module evaluation at about 100–150 ms and React's first render at about
85–95 ms.

**Change.**
- The landing page and Motion now load as their own chunk (`React.lazy`), and so does the team page.
- Board cards animate in with CSS (`@keyframes rise`), so the board no longer needs Motion.

**Result.**

| Chunk | Before | After |
| --- | --- | --- |
| `index` (every page) | 346.7 KB | **270.6 KB** (86 KB gzipped) |
| `Landing` (landing only) | (inside index) | 61.6 KB |
| `motionFeatures` (landing only) | 41 KB | 42.0 KB |
| `skyGL` (three.js, first interaction only) | 518 KB | 530.7 KB |

What remains in `index`, by source size: react-dom 620 KB, react-router 368 KB, app code about 35 KB. There is
nothing left to split without replacing React.

### 2. The live-update stream opened during page load

**Evidence.** The never-ending `/events` request started before the first paint. Lighthouse's simulated throttling
counts a long-lived request as in flight, which inflated its estimate: the live board showed a simulated TBT of
4,950 ms, against 320 ms under real (devtools) throttling.

**Change.** The `EventSource` opens after `load` plus idle (`requestIdleCallback`, with a `setTimeout` fallback). On
its first open every view refetches once, so nothing that happened in between is missed. Replay after that uses
`Last-Event-ID` against the transactional outbox, as before.

### 3. The board's layout shifted by 0.651 on desktop

**Evidence.** Lighthouse put the whole shift on `main#main`. The saved trace showed `main` moving from x=131 to
x=124, and the nav from x=1203 to x=1188, at the moment the cards arrived. The page had become taller than the
window, a classic scrollbar appeared, and the centred layout moved sideways. A Playwright run with overlay
scrollbars did not reproduce it (0.096, from the footer only), which is why it had gone unnoticed.

**Change.**
- `html { scrollbar-gutter: stable }` reserves the scrollbar track.
- While loading, the board list and the lazy-route placeholder are at least `100dvh` tall, so the footer starts below
  the fold instead of being pushed off it. This also fixed the landing page's CLS of 0.117 and 0.134, which came from
  the footer under the short "Loading…" placeholder of the now-lazy landing chunk.

**Result** (single runs, local): board desktop **77 → 100**, CLS 0.651 → 0. Landing desktop CLS 0.117 → 0, mobile
0.134 → 0.012.

### Tried, measured, reverted

| Idea | Measured | Kept? |
| --- | --- | --- |
| `content-visibility: auto` on off-screen board cards | board mobile 89 → 87 (noise; the board shows 20 cards) | no |
| Rendering the board list inside `startTransition` | board mobile 73, 86, 88 against 87–89 before | no |
| Skipping the refetch on the stream's first open | 87 and 72 | no (it is also needed for correctness) |

On mobile, the board's remaining cost is React itself: one task of about 280 ms under 4× throttling (about 70 ms
unthrottled), which is React's first render of the page.

## Lighthouse, after (median of 5 runs)

| Where | Page | Form | Performance (median) | 5 runs | Accessibility | Best practices | SEO | LCP | TBT | CLS |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Live (Singapore) | Landing | desktop | **100** | 98 100 100 100 100 | 100 | 100 | 100 | 0.5 s | 10 ms | 0 |
| Live (Singapore) | Landing | mobile | **91** | 71 87 91 95 97 | 100 | 100 | 100 | 1.9 s | 380 ms | 0 |
| Live (Singapore) | Board | desktop | **96** | 93 95 96 100 100 | 100 | 100 | 100 | 0.5 s | 170 ms | 0.037 |
| Live (Singapore) | Board | mobile | **86** | 75 77 86 87 90 | 100 | 100 | 100 | 1.7 s | 470 ms | 0.082 |
| Local | Landing | desktop | **100** | 100 100 100 100 100 | 100 | 100 | 100 | 0.6 s | 20 ms | 0 |
| Local | Landing | mobile | **97** | 96 96 97 97 98 | 100 | 100 | 100 | 2.5 s | 120 ms | 0.012 |
| Local | Board | desktop | **93** | 76 88 93 100 100 | 100 | 100 | 100 | 0.6 s | 210 ms | 0 |
| Local | Board | mobile | **86** | 78 86 86 87 89 | 100 | 100 | 100 | 2.6 s | 430 ms | 0 |

Lighthouse 13.6.0, desktop preset and mobile emulation (simulated throttling), run from a laptop in India.
The median run's HTML and JSON reports are in [docs/lighthouse/](docs/lighthouse/).

**Board on mobile misses 90: median 86, both live and local.** The rest of its cost is React itself: one task of
about 280 ms under 4× CPU throttling, which is the first render of React, React Router and the page. Three further
attempts did not move it (see "Tried, measured, reverted"). The live board's small CLS (0.037 and 0.082) comes from the
footer: the live database holds only a couple of test teams, so the real list is shorter than the full-screen
placeholder and the footer moves up into view. With seed data loaded, the list is longer than the screen.

Before, for comparison (earlier passes, recorded in README.md):
- Live board on mobile: 78 and 80. Simulated TBT on the live board was as high as 4,950 ms.
- Local board on mobile: 86 (CLS 0.045). Local landing on mobile: 91.
- Local board on desktop, measured after the code split but before the layout fix: 77 (CLS 0.651).

## Server side

The board is a cursor-paginated index scan (`{hackathonId, isOpen, _id}`). In front of it is a single-flight page
cache: TTL 1 s, cleared on every committed change, answered before any middleware, and concurrent misses wait on one
query.

| Where | Load | client p95 | server p95 (`Server-Timing: app`) | failed |
| --- | --- | ---: | ---: | ---: |
| Local | 100 users flat out (7,222 req/s) | 21 ms | under 0.01 ms (cache hit) | 0 |
| Local | 100 users paced | 2.1 ms | under 0.01 ms | 0 |
| Live, Singapore | 100 users paced | 145 ms | 46.6 ms | 0 |
| Live, Singapore | 100 users flat out (379 req/s) | 590 ms | 96.6 ms | 0 |

Full tables: [LOAD_TEST_REMOTE.md](LOAD_TEST_REMOTE.md), [LOAD_TEST_REGIONAL.md](LOAD_TEST_REGIONAL.md), and
[docs/loadtest/local.json](docs/loadtest/local.json). The cache-off numbers from `npm run loadtest` (p95 81 ms at
1,500 req/s locally) are in [LOAD_TEST.md](LOAD_TEST.md).

Nothing was weakened for these numbers. Transactions, idempotency, rate limits and the CSRF check are all on in
every run.
