import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { afterAll, describe, expect, it } from 'vitest';
import { testEnv } from './helpers.js';

// Chaos test: the REAL server is started as a separate process, hit with concurrent joins that carry
// Idempotency-Keys, and killed with SIGKILL (no shutdown hooks, no goodbye) while requests are in flight.
// It is restarted on the same database and every request is retried with the same key. The database must
// come out exactly right: no half-applied join, no double join, nobody lost, and a join that committed
// before the kill must be answered with its original success, not a confusing conflict.

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const TEAMS = 30;
const MAX = 4; // MAX_TEAM_SIZE in .env.example: each team has its leader plus exactly 3 free seats
const JOINERS = TEAMS * (MAX - 1);

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env, PORT: String(port) }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return { child, url };
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('server did not start');
}

const stop = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });

async function signup(url, label, password) {
  const res = await fetch(`${url}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${label}@example.com`, password, displayName: label, skills: ['backend'], timezone: 'UTC' }),
  });
  if (res.status !== 201) throw new Error(`signup ${label}: ${res.status}`);
  return { id: (await res.json()).user.id, cookie: res.headers.getSetCookie()[0].split(';')[0] };
}

const pool = async (items, size, fn) => {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
};

async function round(roundNumber) {
  const database = `chaos_${randomBytes(5).toString('hex')}`;
  // A request killed before it committed leaves a short lock on its key; one second keeps the retry loop quick.
  const env = testEnv({ IDEMPOTENCY_LOCK_SECONDS: '1' }, database);
  const password = randomBytes(12).toString('base64url');
  const tag = `r${roundNumber}${randomBytes(2).toString('hex')}`;
  let { child, url } = await startServer(env);

  // setup, before any chaos: 30 teams of one, 90 people who each want a seat
  const leaders = Array.from({ length: TEAMS }, (_, i) => `${tag}-lead-${i}`);
  const joiners = Array.from({ length: JOINERS }, (_, i) => `${tag}-join-${i}`);
  const accounts = {};
  await pool([...leaders, ...joiners], 24, async (label) => (accounts[label] = await signup(url, label, password)));
  const meta = await (await fetch(`${url}/api/meta`)).json();
  const codes = [];
  for (const label of leaders) {
    const res = await fetch(`${url}/api/hackathons/${meta.hackathon.id}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: accounts[label].cookie },
      body: JSON.stringify({ name: `Chaos ${label}` }),
    });
    codes.push((await res.json()).invite.code);
  }

  const keyOf = (i) => `chaos-${tag}-${i}`;
  const join = (u, i, base) =>
    fetch(`${base}/api/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: accounts[u].cookie, 'idempotency-key': keyOf(i) },
      body: JSON.stringify({ code: codes[i % TEAMS] }),
    });

  // chaos: everyone joins at once; the server is killed while those requests are in flight
  const client = await new MongoClient(env.MONGODB_URI).connect();
  const db = client.db(database);
  // The default lifetime (60 s) only slows this test down; the behaviour under test is the same at any value.
  await client.db('admin').command({ setParameter: 1, transactionLifetimeLimitSeconds: 3 });
  const outcomes = joiners.map(() => null);
  const inFlight = joiners.map((u, i) =>
    join(u, i, url).then(async (r) => (outcomes[i] = { status: r.status, code: r.status === 200 ? 'ok' : (await r.json()).error.code }), () => undefined),
  );
  // Aim the kill: watch the database and fire the instant a random number of joins has committed. Those commits
  // are milliseconds old, so their responses are still on their way out: exactly the window worth testing.
  const killAt = TEAMS + 4 + Math.floor(Math.random() * 40);
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && (await db.collection('memberships').countDocuments()) < killAt; ) await sleep(1);
  await stop(child);
  await Promise.allSettled(inFlight);

  // inspect the wreckage directly in MongoDB before anything is retried
  const afterKill = new Set((await db.collection('memberships').find({}).toArray()).map((m) => String(m.userId)));
  const committedButUnanswered = joiners.filter((u, i) => outcomes[i] === null && afterKill.has(accounts[u].id)).length;
  const neverCommitted = joiners.filter((u, i) => outcomes[i] === null && !afterKill.has(accounts[u].id)).length;

  // restart on the same database and retry EVERY request with its original key
  ({ child, url } = await startServer(env));
  const retries = joiners.map(() => null);
  await pool(joiners, 24, async (u, i) => {
    let r = await join(u, i, url);
    // "still in progress" is the documented answer while a dead request's lock runs out: wait as told and ask again
    // "busy" is the other documented retryable answer: the killed server's open transactions still hold locks
    // on the teams they touched until MongoDB expires them. Neither stored anything, so retrying with the key is safe.
    const retryable = async (x) => x.status === 503 || (x.status === 409 && (await x.clone().json()).error.code === 'idempotency_in_progress');
    for (let attempt = 0; attempt < 120 && (await retryable(r)); attempt++) {
      await sleep(500);
      r = await join(u, i, url);
    }
    retries[i] = { status: r.status, replayed: r.headers.get('idempotency-replayed') === 'true', code: r.status === 200 ? 'ok' : (await r.json()).error.code };
  });
  await stop(child);

  // the verdict
  const memberships = await db.collection('memberships').find({}).toArray();
  const teams = await db.collection('teams').find({}).toArray();
  const audit = await db.collection('auditLog').find({ action: 'member.joined_by_invite' }).toArray();
  const group = (rows, key) => rows.reduce((m, row) => m.set(key(row), [...(m.get(key(row)) ?? []), row]), new Map());
  const perUser = group(memberships, (m) => String(m.userId));
  const perTeam = group(memberships, (m) => String(m.teamId));
  await client.close();
  return { retries, outcomes, memberships, teams, audit, perUser, perTeam, committedButUnanswered, neverCommitted, joiners, accounts };
}

describe('chaos: kill -9 the server in the middle of a burst of joins', () => {
  afterAll(async () => {
    const client = await new MongoClient(testEnv().MONGODB_URI).connect();
    await client.db('admin').command({ setParameter: 1, transactionLifetimeLimitSeconds: 60 });
    await client.close();
  });

  it('leaves nothing corrupted, duplicated or lost, and replays answers the dead server never delivered', async () => {
    let committedButUnanswered = 0;
    let neverCommitted = 0;
    for (let n = 0; n < 6 && committedButUnanswered < 3; n++) {
      const r = await round(n);
      committedButUnanswered += r.committedButUnanswered;
      neverCommitted += r.neverCommitted;

      // 1. every retry succeeded: either the original answer replayed, or the request ran now (it never committed)
      expect(r.retries.map((x) => x.code), 'every retried join is a success').toEqual(r.retries.map(() => 'ok'));
      // 2. nobody is on two teams, nobody is on none: exactly the leaders plus every joiner, once each
      expect(r.memberships).toHaveLength(TEAMS + JOINERS);
      for (const rows of r.perUser.values()) expect(rows).toHaveLength(1);
      // 3. every team is exactly full, and its counter matches its member rows
      expect(r.teams).toHaveLength(TEAMS);
      for (const t of r.teams) {
        expect(t.memberCount).toBe(MAX);
        expect(r.perTeam.get(String(t._id))).toHaveLength(MAX);
        expect(t.isOpen).toBe(false);
      }
      // 4. exactly one audit entry per join: nothing committed without its audit row, nothing logged twice
      expect(r.audit).toHaveLength(JOINERS);
      // 5. a join that committed before the kill but was never answered is replayed as the ORIGINAL success
      r.joiners.forEach((u, i) => {
        if (r.outcomes[i] !== null) expect(r.outcomes[i].code).toBe('ok');
      });
    }
    // The test is only meaningful if the kill really landed between commit and response at least once.
    expect(committedButUnanswered, 'joins that committed but were never answered before the kill').toBeGreaterThan(0);
    console.log(JSON.stringify({ committedButUnanswered, neverCommitted }));
  }, 240_000);
});
