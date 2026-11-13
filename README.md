# The Last Seat

Team formation for a hackathon with 10,000 participants, built so that a seat can only be claimed once.
When 50 people hit "join" on a team with one free seat in the same instant, exactly one gets it and 49 get a clean `409`.

- **How it works and why:** [DESIGN.md](DESIGN.md)
- **Load test numbers:** [LOAD_TEST.md](LOAD_TEST.md)
- **Visual direction:** [DESIGN_BRIEF.md](DESIGN_BRIEF.md)

## Run it

Needs Node 20.12+ and Docker (or any MongoDB **replica set**; transactions do not work on a standalone server).

```bash
docker compose up -d                 # single-node MongoDB replica set on 127.0.0.1:27017
cp .env.example .env                 # then set JWT_SECRET and SEED_PASSWORD (the file says how)
npm install && npm run build         # installs the server, builds the UI into web/dist
npm run seed                         # 10,000 users, 2,000 teams
npm start                            # http://localhost:4000
```

Log in as `seed-00001@seed.invalid` with your `SEED_PASSWORD`, or sign up.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` / `npm run dev` | API (and the built UI, if `web/dist` exists) on `PORT` |
| `npm run dev:web` | Vite dev server for the UI, proxying `/api` to `PORT` |
| `npm test` | 69 API tests over real HTTP against a real MongoDB replica set (started automatically) |
| `npm run test:e2e -- http://localhost:4000` | Drives the real UI in your installed Chrome against a running app: signup, create team, live update, two browsers racing for the last seat, keyboard and reduced-motion checks. Saves the screenshots below |
| `npm run lint` / `npm run typecheck` | ESLint for the server, oxlint and `tsc` for the UI |
| `npm run seed` | Inserts `SEED_USERS` users and `SEED_TEAMS` teams; safe to re-run |
| `npm run loadtest` | autocannon against the board endpoint; writes `LOAD_TEST.md` |

## What the tests cover

Nothing is mocked. Each test file boots the app on a real port against its own database.

| File | Tests | Covers |
| --- | --- | --- |
| `test/races.test.js` | 15 | 50 users for one seat (5 rounds), double-click, one user joining two teams, two accepts for the last seat, the same request accepted twice, leader leaving during joins, last member leaving during a join |
| `test/idempotency.test.js` | 9 | replay, 20 concurrent duplicates, replayed errors, key reuse, per-user scope, crashed-request recovery, signup replay |
| `test/rules.test.js` | 30 | auth, validation, min/max, invite expiry and regeneration, leader-only actions, requests, leadership transfer, team deletion, audit log, board pagination and query plan |
| `test/limits-realtime-suggestions.test.js` | 15 | rate limits triggering, SSE delivery, replay and reset, suggestion scoring |

## Architecture

```
src/
  config.js        every setting, from env, validated with zod at startup (no in-code defaults)
  db.js            connection, indexes, withTxn (bounded retries on write conflicts)
  teams.js         the domain: claimSeat, join, leave, transfer, requests, audit
  idempotency.js   Idempotency-Key middleware
  events.js        SSE bus with event ids and a replay buffer
  suggestions.js   scoring (pure function) and the two ranking queries
  http.js          errors, validation helper, session cookie
  app.js           routes
web/src/           React + Vite + TypeScript UI (three.js sky is lazy-loaded in its own chunk)
scripts/           seed and load test
```

One Node process serves the API, the event stream and the built UI from one origin, so cookies and SSE need no CORS setup.

## API

All bodies are JSON. Errors are `{ "error": { "code", "message", "details"? }, "requestId" }`. Mutations accept `Idempotency-Key`.

| Method and path | Who | Purpose |
| --- | --- | --- |
| `POST /api/auth/signup`, `/login`, `/logout` | anyone | session cookie |
| `GET /api/me`, `GET /api/meta` | anyone | current user (or null), skills and hackathon |
| `GET /api/hackathons/:id/teams?cursor&limit&skill` | anyone | the board: open teams, newest first |
| `GET /api/hackathons/:id/events` | anyone | server-sent events |
| `POST /api/hackathons/:id/teams` | user | create a team, returns the invite code once |
| `POST /api/invites/redeem` | user | join instantly with a code |
| `GET /api/hackathons/:id/me` | user | my team and pending requests |
| `GET /api/hackathons/:id/suggestions?kind=people\|teams` | user | ranked matches with a score breakdown |
| `GET /api/teams/:id` | user | team and members |
| `POST /api/teams/:id/requests` | user | ask to join |
| `POST /api/requests/:id/cancel` | requester | withdraw a request |
| `GET /api/teams/:id/requests`, `POST /api/requests/:id/accept\|decline` | leader | inbox |
| `POST /api/teams/:id/invite` | leader | new invite code (the old one stops working) |
| `DELETE /api/teams/:id/members/:userId` | leader | remove a member |
| `POST /api/teams/:id/leave` | member | leave; leadership transfers; last member deletes the team |
| `GET /api/teams/:id/audit` | leader | team history |

## Deploy (free tier)

Nothing is deployed yet: it needs accounts only you can create.

1. **MongoDB Atlas**: create a free M0 cluster (it is a replica set), a database user, and allow access from anywhere. Copy the `mongodb+srv://` connection string.
2. **Render**: New → Blueprint → pick this repository. `render.yaml` defines the service. Fill in the two prompted values: `MONGODB_URI` (from step 1) and `SEED_PASSWORD`. `JWT_SECRET` is generated for you.
3. Open the URL Render gives you. Check `GET /api/health` returns `{"status":"ok"}`, sign up, create a team, and open the board in a second browser to watch it update.
4. Optional: run `npm run seed` locally with `MONGODB_URI` pointing at Atlas to fill the board.

Free instances sleep when idle; the first request after a pause takes about a minute.

## Screenshots

Captured by `npm run test:e2e` from the running app (seeded data plus the accounts the test creates).

| Landing | Landing after scrolling: points gathered into constellations |
| --- | --- |
| ![Landing](docs/screenshots/landing-desktop.png) | ![Gathered](docs/screenshots/landing-gathered-desktop.png) |

| Board, with "Last seat" teams | Team page: constellation, inbox, invite code |
| --- | --- |
| ![Board](docs/screenshots/board-desktop.png) | ![Team](docs/screenshots/team-desktop.png) |

| Losing the race (phone) | Board (phone) | Landing (phone) | Reduced motion |
| --- | --- | --- | --- |
| ![Lost](docs/screenshots/lost-the-race.png) | ![Board mobile](docs/screenshots/board-mobile.png) | ![Landing mobile](docs/screenshots/landing-mobile.png) | ![Reduced](docs/screenshots/landing-reduced-motion.png) |

### Colour palettes

Four palettes, switchable from the "Colours" menu in the status bar (the choice is remembered). The 3D sky reads
its star colours from the same CSS tokens, so it changes with the palette. Aurora is the default.

| Aurora | Midnight gold | Nebula | Ember |
| --- | --- | --- | --- |
| ![Aurora landing](docs/screenshots/theme-aurora-landing.png) | ![Midnight landing](docs/screenshots/theme-midnight-landing.png) | ![Nebula landing](docs/screenshots/theme-nebula-landing.png) | ![Ember landing](docs/screenshots/theme-ember-landing.png) |
| ![Aurora board](docs/screenshots/theme-aurora-board.png) | ![Midnight board](docs/screenshots/theme-midnight-board.png) | ![Nebula board](docs/screenshots/theme-nebula-board.png) | ![Ember board](docs/screenshots/theme-ember-board.png) |

### Scroll story

The landing page is driven by scroll position: a progress bar, a hero that recedes, story sections that slide in
with a numeral drifting behind them, the camera moving into the sky, and a pinned scene where scrolling fills a
team's seats one at a time until the last one is taken.

![Pinned seat scene](docs/screenshots/landing-scene-desktop.png)

## Measured

Lighthouse 13, mobile emulation (slow 4G, 4x CPU slowdown), against the production build served locally by `npm start`, in the default Aurora palette (contrast in the other three palettes was chosen to the same ratios but not run through Lighthouse).
These are local numbers; a deployed free-tier instance will differ.

| Page | Performance | Accessibility | Best practices | LCP | TBT | CLS |
| --- | --- | --- | --- | --- | --- | --- |
| Landing | 91 | 100 | 100 | 2.7 s | 260 ms | 0 |
| Board | 86 | 100 | 100 | 2.7 s | 390 ms | 0.045 |

- Initial JavaScript: 115 KB gzipped. three.js (131 KB) and the animation engine (19 KB) are separate chunks.
- The 3D sky is requested on the visitor's first interaction (move, scroll, touch, key), never during page load,
  so Lighthouse measures the page before WebGL starts. Until then a CSS star field is shown.
- Frame rate with the sky running: 144 fps on the development laptop (headless Chrome, 144 Hz display).
  It has not been measured on a phone.

The first Lighthouse run scored 65 and 58 for performance. What changed: gzip and immutable caching for the built
files, the hero text no longer waits for a script to become visible, three.js no longer loads during page load,
card layout measurement was removed, and looping animations now touch only transform and opacity.

## Design review

Scored against [DESIGN_BRIEF.md](DESIGN_BRIEF.md) after the last pass. Self-assessed, not an external jury.

| Criterion | Score | Notes |
| --- | --- | --- |
| Concept carried through | 8/10 | Sky, constellation, "last seat" and the lost-race panel all tell the same story |
| Typography and hierarchy | 8/10 | Two variable fonts, fluid scale, one accent colour used sparingly |
| Motion with purpose | 8/10 | Scroll drives the sky, the story sections and a pinned seat scene; cards enter and leave |
| Accessibility | 9/10 | Lighthouse 100; keyboard path and reduced motion are asserted by the browser test |
| Performance | 8/10 | Meets the 85 target locally; unmeasured on real phones |

Problems the review loop found and fixed: focus jumped past the skip link on first load; story sections stayed
invisible under reduced motion; the largest text waited on a lazy script; local builds shipped React's development build.

Weakest points that remain: board cards snap, not glide, when a neighbour leaves; the team history shows short user
ids, not names; the landing page has no imagery beyond the sky.

## Not done, stated plainly

- Not deployed yet, so every number above is local. `render.yaml` and the steps above are ready.
- The sky is plain three.js driven by scroll position, not react-three-fiber, and scroll choreography uses Motion's
  in-view triggers, not GSAP ScrollTrigger timelines.
- The browser test needs Chrome installed and a running app, so it is not part of CI.
- Signed-out board viewers can watch but must sign up to act.

## Five-minute walkthrough checklist

1. **(30 s) The problem.** One seat, many people, same instant. Show the board with a "Last seat" team.
2. **(60 s) The seat claim.** Open `src/teams.js` at `claimSeat`. Say why the conditional update and the transaction are both needed (DESIGN.md has the two sentences).
3. **(60 s) Prove it.** Run `npx vitest run test/races.test.js`. Then delete the `$expr` guard, run round 1 again, show 40 winners, restore it.
4. **(45 s) Idempotency.** `src/idempotency.js`: the `_id` is the lock. Run `test/idempotency.test.js`. Mention the commit/record gap and why the indexes cover it.
5. **(45 s) Live.** Two browser windows: join with an invite code in one, watch the other update. Kill and restart the server to show reconnect.
6. **(30 s) Performance.** Open `LOAD_TEST.md`: both columns, and the three causes of the first failure.
7. **(30 s) Limits.** Single instance for SSE, rate limits and cache; the Redis path. What you would do with one more week.
