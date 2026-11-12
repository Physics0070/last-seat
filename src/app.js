import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import cookieParser from 'cookie-parser';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { isDuplicateKey } from './db.js';
import { createEventBus } from './events.js';
import { AppError, SESSION_COOKIE, cookieOptions, errorHandler, notFound, objectId, parse, readUser, requireAuth, signSession } from './http.js';
import { idempotency } from './idempotency.js';
import { SKILLS, isTimezone, suggestPeople, suggestTeams, utcOffsetMinutes } from './suggestions.js';
import * as teams from './teams.js';

const webDist = fileURLToPath(new URL('../web/dist', import.meta.url));

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
  const bus = createEventBus(config);
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

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
  const redeemIpLimit = limiter(config.REDEEM_RATE_LIMIT_WINDOW_MS, config.REDEEM_RATE_LIMIT_IP_MAX);
  const redeemUserLimit = limiter(config.REDEEM_RATE_LIMIT_WINDOW_MS, config.REDEEM_RATE_LIMIT_USER_MAX, (req) => String(req.user.id));

  const api = express.Router();
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

  // Serialized board pages by URL. Every committed team change clears the map, so a reader never sees a page
  // older than the last event this instance published; the TTL bounds staleness from other instances' writes.
  // ponytail: per-process cache. With several instances, clear it from the shared event stream as well.
  const boardCache = new Map();
  let boardVersion = 0;

  /** Runs a mutation, then publishes its events. Events go out only after the transaction has committed. */
  const mutate = (status, fn) => async (req, res) => {
    const { result, events } = await fn(req, actorOf(req));
    if (events.length) {
      boardVersion++;
      boardCache.clear();
    }
    bus.publish(ctx.hackathon._id, events);
    res.status(status).json(result);
  };

  // ---------- public ----------

  api.get('/health', async (_req, res) => {
    await ctx.db.command({ ping: 1 });
    res.json({ status: 'ok' });
  });

  api.get('/meta', (_req, res) => res.json({ skills: SKILLS, hackathon: publicHackathon(ctx.hackathon) }));

  // Verified against when the email is unknown, so login takes the same time either way.
  const dummyHash = await argon2.hash(randomBytes(16).toString('hex'));

  api.post('/auth/signup', authLimit, async (req, res) => {
    const body = parse(schemas.signup, req.body);
    const user = {
      email: body.email,
      passwordHash: await argon2.hash(body.password),
      displayName: body.displayName,
      skills: body.skills,
      timezone: body.timezone,
      // ponytail: offset is captured at signup, so it drifts by an hour across DST changes. Recompute nightly if that matters.
      utcOffsetMinutes: utcOffsetMinutes(body.timezone),
      createdAt: new Date(),
    };
    try {
      const { insertedId } = await ctx.users.insertOne(user);
      startSession(res, insertedId);
      res.status(201).json({ user: selfUser({ ...user, _id: insertedId }) });
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'email_taken', 'An account with this email already exists.');
      throw err;
    }
  });

  api.post('/auth/login', authLimit, async (req, res) => {
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
      const body = teams.listBoard(ctx, hackathonId(req), page(req)).then(JSON.stringify);
      entry = { body, expires: Date.now() + config.BOARD_CACHE_TTL_MS };
      if (config.BOARD_CACHE_TTL_MS > 0) {
        if (boardCache.size >= config.BOARD_CACHE_MAX_ENTRIES) boardCache.clear();
        boardCache.set(key, entry);
        // Drop the entry if the query failed, or if a team changed while it ran (the page may predate that change).
        const drop = () => boardCache.get(key) === entry && boardCache.delete(key);
        body.then(() => version !== boardVersion && drop(), drop);
      }
    }
    res.type('json').send(await entry.body);
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
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile('index.html', { root: webDist }) : next()));
  }
  app.use(notFound);
  app.use(errorHandler);

  return { app, bus };
}
