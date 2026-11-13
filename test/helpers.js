import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pino } from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db.js';

const exampleEnv = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));

/** Environment for a server process (in-process or spawned): the example config, a private database, nothing rate limited. */
export function testEnv(overrides = {}, database = `test_${randomBytes(6).toString('hex')}`) {
  return {
    ...exampleEnv,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    MONGODB_URI: process.env.TEST_MONGODB_URI,
    MONGODB_DB: database,
    JWT_SECRET: randomBytes(32).toString('hex'),
    RATE_LIMIT_MAX: '100000',
    AUTH_RATE_LIMIT_MAX: '100000',
    REDEEM_RATE_LIMIT_IP_MAX: '100000',
    REDEEM_RATE_LIMIT_USER_MAX: '100000',
    ...overrides,
  };
}

/**
 * Boots the real app on an ephemeral port against a fresh database in the shared replica set.
 * Nothing is mocked: requests travel over real sockets and hit real transactions.
 * Limits default to "never trips" so only the rate-limit tests see a limiter.
 */
export async function startApp(overrides = {}) {
  const config = loadConfig(testEnv(overrides));
  const ctx = await connectDb(config, pino({ level: config.LOG_LEVEL }));
  const { app, bus } = await createApp(ctx);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const hid = String(ctx.hackathon._id);
  let n = 0;

  /** Signs up a new user and returns a client bound to their session cookie. */
  async function user(profile = {}) {
    const email = `user${++n}-${randomBytes(3).toString('hex')}@example.com`;
    const res = await request(url)
      .post('/api/auth/signup')
      .send({ email, password: 'correct horse battery', displayName: `User ${n}`, skills: ['backend'], timezone: 'UTC', ...profile });
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const call = (method, path, body) => {
      const req = request(url)[method](path).set('Cookie', cookie);
      return body === undefined ? req : req.send(body);
    };
    return {
      id: res.body.user.id,
      email,
      cookie,
      get: (path) => call('get', path),
      post: (path, body = {}) => call('post', path, body),
      del: (path) => call('delete', path),
    };
  }

  const users = (count, profile) => Promise.all(Array.from({ length: count }, () => user(profile)));

  /** Creates a team led by a new user, with `members` total members (joined by invite). */
  async function team(members = 1, body = { name: 'Team' }) {
    const leader = await user();
    const res = await leader.post(`/api/hackathons/${hid}/teams`, body);
    if (res.status !== 201) throw new Error(`createTeam failed: ${res.status} ${JSON.stringify(res.body)}`);
    const code = res.body.invite.code;
    const others = await users(members - 1);
    for (const u of others) {
      const joined = await u.post('/api/invites/redeem', { code });
      if (joined.status !== 200) throw new Error(`join failed: ${joined.status} ${JSON.stringify(joined.body)}`);
    }
    return { id: res.body.team.id, code, leader, others };
  }

  /** The invariants that must hold after any interleaving. */
  async function invariants(teamId) {
    const { ObjectId } = await import('mongodb');
    const _id = new ObjectId(teamId);
    const doc = await ctx.teams.findOne({ _id });
    const memberships = await ctx.memberships.find({ teamId: _id }).toArray();
    return { doc, memberships, memberCount: doc?.memberCount, rows: memberships.length };
  }

  async function close() {
    bus.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await ctx.db.dropDatabase();
    await ctx.client.close();
  }

  return { ctx, bus, url, hid, user, users, team, invariants, close, anon: request(url) };
}

export const statuses = (responses) => responses.map((r) => r.status).sort();
