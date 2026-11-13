import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { isDuplicateKey } from './db.js';
import { createEventBus } from './events.js';
import { failureLimiter } from './failure-limiter.js';
import { AppError, SESSION_COOKIE, cookieOptions, errorHandler, notFound, objectId, parse, readUser, requireAuth, signSession } from './http.js';
import { idempotency } from './idempotency.js';
import { requestContext } from './request-context.js';
import { SKILLS, isTimezone, suggestPeople, suggestTeams, utcOffsetMinutes } from './suggestions.js';
import * as teams from './teams.js';

const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));

// argon2id at the OWASP minimum (19 MiB, 2 passes, 1 lane). The library default (64 MiB, 3 passes, 4 lanes) cost
// about 80 ms of CPU per hash and capped one process near 12 signups a second; this is several times cheaper and
// still memory-hard. Verification reads the parameters stored in each hash, so older hashes keep working.
const PASSWORD_HASH = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const BOARD_URL = /^\/api\/hackathons\/[0-9a-f]{24}\/teams(\?.*)?$/i;

const skill = z.enum(SKILLS);
const skillList = z.array(skill).max(8).refine((s) => new Set(s).size === s.length, 'skills must be unique');
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const schemas = {
  signup: z.strictObject({
    email,
    password: z.string().min(8).max(200),
    displayName: z.string().trim().min(1).max(60),
    skills: skillList.min(1),
    timezone: z.string().refine(isTimezone, 'must be an IANA time zone such as Asia/Kolkata'),
  }),
  login: z.strictObject({ email, password: z.string().min(1).max(200) }),
  createTeam: z.strictObject({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(500).default(''),
    lookingFor: skillList.default([]),
  }),
  redeem: z.strictObject({ code: z.string().min(1).max(100) }),
  createRequest: z.strictObject({ message: z.string().trim().max(300).default('') }),
  suggestions: z.strictObject({ kind: z.enum(['people', 'teams']).default('people') }),
  empty: z.strictObject({}),
  id: z.strictObject({ id: objectId }),
  member: z.strictObject({ id: objectId, userId: objectId }),
};

export async function createApp(ctx) {
  const { config } = ctx;
  const bus = await createEventBus(ctx);
  const relayed = await bus.relay();
  if (relayed) ctx.log.warn({ relayed }, 'published events left unpublished by a previous process');
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.locals.metrics = ctx.metrics;
  ctx.metrics.describeGauge('sse_clients', 'Open live-update connections.', () => bus.clientCount());
  ctx.metrics.describeGauge('board_cache_entries', 'Serialized board pages currently cached.', () => boardCache.size);
  ctx.metrics.describeGauge('process_resident_memory_bytes', 'Resident memory of this process.', () => process.memoryUsage.rss());
  ctx.metrics.describeGauge('process_uptime_seconds', 'Seconds since this process started.', () => Math.round(process.uptime()));
  // Event-loop delay over the last minute: how long ready work waited for the single JavaScript thread.
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  setInterval(() => loopDelay.reset(), 60_000).unref();
  ctx.metrics.describeGauge('event_loop_delay_p99_ms', 'p99 event-loop delay over the last minute, in ms.', () => (loopDelay.percentile(99) / 1e6).toFixed(1));
  ctx.metrics.describeGauge('event_loop_delay_mean_ms', 'Mean event-loop delay over the last minute, in ms.', () => (loopDelay.mean / 1e6).toFixed(1));

  // Serialized board pages by URL. Every committed team change clears the map, so a reader never sees a page
  // older than the last event this instance published; the TTL bounds staleness from other instances' writes.
  // ponytail: per-process cache. With several instances, clear it from the shared event stream as well.
  const boardCache = new Map();
  let boardVersion = 0;
  /** Called after any committed change to teams or members: drops every cache built from that data. */
  const bump = () => {
    boardVersion++;
    ctx.poolVersion++;
    boardCache.clear();
  };

  // Fast path for the hottest request. A cached board page is answered before logging, helmet, the rate limiter and
  // the body parsers run: together they cost more CPU than the response, and on a small instance CPU is the ceiling.
  // It serves exactly the bytes the normal path cached, so staleness is identical. Reads cost nothing to protect
  // here (no database work), which is why they are not rate limited; anything that misses falls through to the full stack.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !BOARD_URL.test(req.url)) return next();
    const hit = boardCache.get(req.originalUrl);
    if (!hit || hit.expires <= Date.now()) return next();
    const started = process.hrtime.bigint();
    const send = (bytes, how) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      ctx.metrics.inc('board_fast_path_hits_total');
      ctx.metrics.observe('http_request_duration_ms', { method: 'GET', route: '/api/hackathons/:id/teams (fast path)', status: 200 }, ms);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bytes.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'Server-Timing': `cache;desc="${how}", app;dur=${ms.toFixed(2)}`,
      });
      res.end(bytes);
    };
    if (hit.ready) return send(hit.ready, 'hit');
    // The page is being built right now. Wait for that one query instead of running the full stack (and spending
    // rate-limit budget) once per waiting request: on a slow instance a hundred readers can pile up behind one rebuild.
    // If the query fails, fall through to the normal path, which reports the error properly.
    hit.body.then((json) => send(Buffer.from(json), 'shared'), () => next());
  });

  app.use(
    pinoHttp({
      logger: ctx.log,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );
  app.use(helmet());
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    // Handlers push [name, ms, description?]; the header is written just before the response headers go out.
    res.locals.timings = [];
    const writeHead = res.writeHead;
    res.writeHead = function writeHeadWithTiming(...args) {
      const total = Number(process.hrtime.bigint() - started) / 1e6;
      const parts = res.locals.timings.map(([name, ms, desc]) => `${name};dur=${ms.toFixed(2)}${desc ? `;desc="${desc}"` : ''}`);
      if (!this.headersSent) this.setHeader('Server-Timing', [...parts, `app;dur=${total.toFixed(2)}`].join(', '));
      return writeHead.apply(this, args);
    };
    res.on('finish', () => {
      // Express clears baseUrl before 'finish', so the router's mount point is restored from the URL.
      const route = req.route ? `${req.originalUrl.startsWith('/api/') ? '/api' : ''}${req.route.path}` : 'static_or_unmatched';
      ctx.metrics.observe('http_request_duration_ms', { method: req.method, route, status: res.statusCode }, Number(process.hrtime.bigint() - started) / 1e6);
    });
    next();
  });
  app.get('/metrics', (_req, res) => res.type('text/plain; version=0.0.4').send(ctx.metrics.render()));

  const limiter = (windowMs, limit, keyGenerator) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      ...(keyGenerator && { keyGenerator }),
      handler: (_req, _res, next) => next(new AppError(429, 'rate_limited', 'Too many requests, slow down.')),
    });
  // ponytail: counters live in process memory (one instance). Scale-out path: rate-limit-redis as the store.
  const authLimit = limiter(config.RATE_LIMIT_WINDOW_MS, config.AUTH_RATE_LIMIT_MAX);
  // Invite brute-force protection spends its budget on wrong guesses (404 invite_invalid), per address and per user.
  // Valid codes on a full team are not guesses, so a crowd behind one connection is never throttled for racing.
  const wrongGuess = (res) => res.statusCode === 404;
  const redeemIpLimit = failureLimiter({ windowMs: config.REDEEM_RATE_LIMIT_WINDOW_MS, max: config.REDEEM_RATE_LIMIT_IP_MAX, key: (req) => ipKeyGenerator(req.ip), isFailure: wrongGuess });
  const redeemUserLimit = failureLimiter({ windowMs: config.REDEEM_RATE_LIMIT_WINDOW_MS, max: config.REDEEM_RATE_LIMIT_USER_MAX, key: (req) => String(req.user.id), isFailure: wrongGuess });

  const api = express.Router();
  // CSRF defence in depth on top of the SameSite=Lax cookie: a browser always sends Origin on a cross-site write, so any
  // write whose Origin is not this host is refused. Requests without Origin (curl, server-to-server) carry no ambient
  // browser credentials worth forging. No CORS headers are sent at all, so other sites cannot read API responses either.
  api.use((req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin) return next();
    const host = URL.canParse(origin) ? new URL(origin).host : null;
    return next(host === req.get('host') ? undefined : new AppError(403, 'cross_origin', 'Cross-site requests are not allowed.'));
  });
  api.use(limiter(config.RATE_LIMIT_WINDOW_MS, config.RATE_LIMIT_MAX));
  api.use(express.json({ limit: '16kb' }));
  api.use(cookieParser());

  const actorOf = (req) => ({ userId: req.user.id, requestId: req.id });
  const selfUser = (u) => ({ id: String(u._id), email: u.email, displayName: u.displayName, skills: u.skills, timezone: u.timezone });
  const publicHackathon = (h) => ({ id: String(h._id), slug: h.slug, name: h.name, minTeamSize: h.minTeamSize, maxTeamSize: h.maxTeamSize });
  const startSession = (res, userId) => res.cookie(SESSION_COOKIE, signSession(config, userId), cookieOptions(config));

  /** Only the configured hackathon exists; any other id is a 404. */
  const hackathonId = (req) => {
    const { id } = parse(schemas.id, req.params);
    if (!id.equals(ctx.hackathon._id)) throw new AppError(404, 'hackathon_not_found', 'This hackathon does not exist.');
    return id;
  };
  // Built once: constructing a zod schema per request is far more expensive than using one.
  const pageQuery = z.strictObject({
    cursor: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(config.BOARD_PAGE_SIZE_MAX).default(config.BOARD_PAGE_SIZE_DEFAULT),
    skill: skill.optional(),
  });
  const page = (req) => parse(pageQuery, req.query);

  /** Runs a mutation, then publishes its events. Events go out only after the transaction has committed. */
  const mutate = (status, fn) => async (req, res) => {
    // Tell the transaction helper what success looks like, so a keyed request's response commits with the change.
    const store = requestContext.getStore();
    if (store) store.status = status;
    const txnStarted = performance.now();
    const { result, events } = await fn(req, actorOf(req));
    res.locals.timings.push(['txn', performance.now() - txnStarted]);
    if (events.length) bump();
    // Sending happens immediately; only the sequence stamp waits on the database, and the response does not wait for it.
    bus.publish(events).catch((err) => req.log.error({ err }, 'failed to stamp published events'));
    res.status(status).json(result);
  };

  // ---------- public ----------

  api.get('/health', async (_req, res) => {
    await ctx.db.command({ ping: 1 });
    res.json({ status: 'ok' });
  });

  api.get('/meta', (_req, res) => res.json({ skills: SKILLS, hackathon: publicHackathon(ctx.hackathon) }));

  // Verified against when the email is unknown, so login takes the same time either way.
  const dummyHash = await argon2.hash(randomBytes(16).toString('hex'), PASSWORD_HASH);

  // A replayed signup or login must also restore the session cookie, which is not part of the stored body.
  const authIdempotency = idempotency(ctx, {
    onReplay: (res, record) => record.status < 300 && record.body.user && startSession(res, record.body.user.id),
  });

  api.post('/auth/signup', authLimit, authIdempotency, async (req, res) => {
    const body = parse(schemas.signup, req.body);
    const user = {
      email: body.email,
      passwordHash: await argon2.hash(body.password, PASSWORD_HASH),
      displayName: body.displayName,
      skills: body.skills,
      timezone: body.timezone,
      // ponytail: offset is captured at signup, so it drifts by an hour across DST changes. Recompute nightly if that matters.
      utcOffsetMinutes: utcOffsetMinutes(body.timezone),
      createdAt: new Date(),
    };
    try {
      const { insertedId } = await ctx.users.insertOne(user);
      ctx.poolVersion++; // a new person changes who can be suggested
      startSession(res, insertedId);
      res.status(201).json({ user: selfUser({ ...user, _id: insertedId }) });
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'email_taken', 'An account with this email already exists.');
      throw err;
    }
  });

  api.post('/auth/login', authLimit, authIdempotency, async (req, res) => {
    const body = parse(schemas.login, req.body);
    const user = await ctx.users.findOne({ email: body.email });
    const ok = await argon2.verify(user?.passwordHash ?? dummyHash, body.password);
    if (!user || !ok) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
    startSession(res, user._id);
    res.json({ user: selfUser(user) });
  });

  api.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });

  // "Who am I?" is public and answers { user: null } without a session, so a signed-out page load is not an error.
  api.get('/me', async (req, res) => {
    const session = readUser(config, req);
    const user = session && (await ctx.users.findOne({ _id: session.id }));
    res.json({ user: user ? selfUser(user) : null });
  });

  api.get('/hackathons/:id/teams', async (req, res) => {
    const key = req.originalUrl;
    let entry = boardCache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      const version = boardVersion;
      // The promise itself is cached, so 100 concurrent misses for a page share one query (no stampede on expiry).
      const timing = {};
      const queryStarted = performance.now();
      const body = teams.listBoard(ctx, hackathonId(req), page(req)).then((result) => {
        const serialiseStarted = performance.now();
        const json = JSON.stringify(result);
        timing.db = serialiseStarted - queryStarted;
        timing.ser = performance.now() - serialiseStarted;
        return json;
      });
      entry = { body, ready: null, timing, owner: req, expires: Date.now() + config.BOARD_CACHE_TTL_MS };
      if (config.BOARD_CACHE_TTL_MS > 0) {
        if (boardCache.size >= config.BOARD_CACHE_MAX_ENTRIES) boardCache.clear();
        boardCache.set(key, entry);
        // Drop the entry if the query failed, or if a team changed while it ran (the page may predate that change).
        // Otherwise publish the finished bytes so the fast path can serve them.
        const drop = () => boardCache.get(key) === entry && boardCache.delete(key);
        body.then((json) => {
          if (version !== boardVersion) drop();
          else entry.ready = Buffer.from(json);
        }, drop);
      }
    }
    const json = await entry.body;
    if (entry.owner === req) res.locals.timings.push(['db', entry.timing.db], ['ser', entry.timing.ser]);
    else res.locals.timings.push(['cache', 0, 'shared']);
    res.type('json').send(json);
  });

  api.get('/hackathons/:id/events', (req, res) => bus.subscribe(req, res, hackathonId(req)));

  // ---------- authenticated ----------

  api.use(requireAuth(config), idempotency(ctx));

  api.get('/hackathons/:id/me', async (req, res) => res.json(await teams.getMyState(ctx, actorOf(req), hackathonId(req))));

  api.get('/hackathons/:id/suggestions', async (req, res) => {
    const id = hackathonId(req);
    const { kind } = parse(schemas.suggestions, req.query);
    res.json(kind === 'teams' ? await suggestTeams(ctx, id, req.user.id, teams.publicTeam) : await suggestPeople(ctx, id, req.user.id));
  });

  api.post(
    '/hackathons/:id/teams',
    mutate(201, (req, actor) => {
      hackathonId(req);
      return teams.createTeam(ctx, actor, parse(schemas.createTeam, req.body));
    }),
  );

  api.post(
    '/invites/redeem',
    redeemIpLimit,
    redeemUserLimit,
    mutate(200, (req, actor) => teams.redeemInvite(ctx, actor, parse(schemas.redeem, req.body).code)),
  );

  api.get('/teams/:id', async (req, res) => res.json(await teams.getTeam(ctx, parse(schemas.id, req.params).id)));

  api.post(
    '/teams/:id/invite',
    mutate(200, (req, actor) => {
      parse(schemas.empty, req.body);
      return teams.regenerateInvite(ctx, actor, parse(schemas.id, req.params).id);
    }),
  );

  api.post(
    '/teams/:id/leave',
    mutate(200, (req, actor) => {
      parse(schemas.empty, req.body);
      return teams.removeMember(ctx, actor, parse(schemas.id, req.params).id, actor.userId);
    }),
  );

  api.delete(
    '/teams/:id/members/:userId',
    mutate(200, (req, actor) => {
      const { id, userId } = parse(schemas.member, req.params);
      return teams.removeMember(ctx, actor, id, userId);
    }),
  );

  api.get('/teams/:id/requests', async (req, res) => res.json(await teams.listRequests(ctx, actorOf(req), parse(schemas.id, req.params).id)));

  api.post(
    '/teams/:id/requests',
    mutate(201, (req, actor) => teams.createRequest(ctx, actor, parse(schemas.id, req.params).id, parse(schemas.createRequest, req.body).message)),
  );

  api.post(
    '/requests/:id/accept',
    mutate(200, (req, actor) => {
      parse(schemas.empty, req.body);
      return teams.acceptRequest(ctx, actor, parse(schemas.id, req.params).id);
    }),
  );

  for (const [action, status] of [['decline', 'declined'], ['cancel', 'cancelled']]) {
    api.post(
      `/requests/:id/${action}`,
      mutate(200, (req, actor) => {
        parse(schemas.empty, req.body);
        return teams.closeRequest(ctx, actor, parse(schemas.id, req.params).id, status);
      }),
    );
  }

  api.get('/teams/:id/audit', async (req, res) => {
    const { cursor, limit } = page(req);
    res.json(await teams.listAudit(ctx, actorOf(req), parse(schemas.id, req.params).id, { cursor, limit }));
  });

  api.use(notFound);
  app.use('/api', api);

  // The built frontend, when present, is served by the same process: one origin, so cookies and SSE just work.
  if (existsSync(webDist)) {
    // Mounted after the API on purpose: only the UI's files are compressed, so the event stream is never
    // buffered by gzip and the board endpoint pays no compression cost per request.
    app.use(compression());
    // Files under /assets have a content hash in their name, so they can be cached forever.
    // index.html must always be revalidated, or a browser would keep pointing at old asset names.
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, file) =>
          res.setHeader('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
      }),
    );
    app.use((req, res, next) =>
      req.method === 'GET' ? res.sendFile('index.html', { root: webDist, headers: { 'Cache-Control': 'no-cache' } }) : next(),
    );
  }
  app.use(notFound);
  app.use(errorHandler);

  return { app, bus };
}
