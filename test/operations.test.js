import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { startApp } from './helpers.js';

describe('metrics', () => {
  it('exposes Prometheus text with request timings, rejections and live connections', async () => {
    const t = await startApp();
    try {
      const team = await t.team(4);
      const late = await t.user();
      expect((await late.post('/api/invites/redeem', { code: team.code })).status).toBe(409);

      const res = await t.anon.get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/# TYPE http_request_duration_ms histogram/);
      expect(res.text).toMatch(/http_request_duration_ms_count\{method="POST",route="\/api\/invites\/redeem",status="409"\} 1/);
      expect(res.text).toMatch(/api_errors_total\{code="team_full"\} 1/);
      expect(res.text).toMatch(/^sse_clients 0$/m);
      expect(res.text).toMatch(/^txn_retries_total /m);
      expect(res.text).toMatch(/^process_resident_memory_bytes \d+$/m);
      // aggregate only: no emails, ids or codes
      expect(res.text).not.toMatch(/@example\.com/);
      expect(res.text).not.toContain(team.code);
    } finally {
      await t.close();
    }
  });
});

describe('the board fast path', () => {
  it('answers cached pages before the rate limiter, so reads are never throttled, while everything else still is', async () => {
    const t = await startApp({ RATE_LIMIT_MAX: '5' });
    try {
      const path = `/api/hackathons/${t.hid}/teams`;
      const first = await t.anon.get(path);
      expect(first.status).toBe(200);

      const rest = [];
      for (let i = 0; i < 60; i++) rest.push((await t.anon.get(path)).status);
      expect(rest.every((s) => s === 200)).toBe(true);

      const hits = Number(/^board_fast_path_hits_total (\d+)$/m.exec((await t.anon.get('/metrics')).text)[1]);
      expect(hits).toBeGreaterThanOrEqual(59);
      const again = await t.anon.get(path);
      expect(again.headers['x-content-type-options']).toBe('nosniff');
      expect(again.body).toEqual(first.body);

      // not a loophole: any other endpoint is limited as before
      const meta = [];
      for (let i = 0; i < 8; i++) meta.push((await t.anon.get('/api/meta')).status);
      expect(meta).toContain(429);
    } finally {
      await t.close();
    }
  });

  it('holds a crowd that arrives while a page is being built on that one query, instead of throttling it', async () => {
    const t = await startApp({ RATE_LIMIT_MAX: '5' });
    try {
      const path = `/api/hackathons/${t.hid}/teams?limit=7`; // a page nobody has asked for yet
      const crowd = await Promise.all(Array.from({ length: 100 }, () => t.anon.get(path)));

      expect(crowd.filter((r) => r.status !== 200)).toHaveLength(0);
      const hits = Number(/^board_fast_path_hits_total (\d+)$/m.exec((await t.anon.get('/metrics')).text)[1]);
      expect(hits).toBeGreaterThanOrEqual(90);
    } finally {
      await t.close();
    }
  });

  it('never serves a page older than the last committed change', async () => {
    const t = await startApp();
    try {
      const path = `/api/hackathons/${t.hid}/teams?limit=50`;
      expect((await t.anon.get(path)).body.items).toHaveLength(0);
      await t.anon.get(path); // now a cache hit
      const team = await t.team(1);
      const seen = await t.anon.get(path);
      expect(seen.body.items.map((i) => i.id)).toEqual([team.id]);
    } finally {
      await t.close();
    }
  });
});

describe('passwords', () => {
  it('hashes new passwords with argon2id at the configured cost, and still verifies hashes made with other parameters', async () => {
    const t = await startApp();
    try {
      const u = await t.user();
      const stored = await t.ctx.users.findOne({ email: u.email });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

      // a user created earlier with the library defaults (as the seed script does) can still log in
      const email = `legacy-${randomBytes(3).toString('hex')}@example.com`;
      await t.ctx.users.insertOne({ email, passwordHash: await argon2.hash('an older password'), displayName: 'Legacy', skills: ['ml'], timezone: 'UTC', utcOffsetMinutes: 0, createdAt: new Date() });
      const ok = await t.anon.post('/api/auth/login').send({ email, password: 'an older password' });
      const bad = await t.anon.post('/api/auth/login').send({ email, password: 'not the password' });
      expect(ok.status).toBe(200);
      expect(bad.status).toBe(401);
    } finally {
      await t.close();
    }
  });
});

describe('suggestions cache', () => {
  it('shows a person who signs up right after a cached read', async () => {
    const t = await startApp();
    try {
      const team = await t.team(2, { name: 'Needs a designer', lookingFor: ['design'] });
      const warm = await team.leader.get(`/api/hackathons/${t.hid}/suggestions`);
      expect(warm.status).toBe(200);

      const designer = await t.user({ displayName: 'Brand new', skills: ['design', 'ml'] });
      const fresh = await team.leader.get(`/api/hackathons/${t.hid}/suggestions`);

      expect(fresh.body.suggestions.map((s) => s.user.id)).toContain(designer.id);
    } finally {
      await t.close();
    }
  });

  it('stops suggesting someone the moment they join a team', async () => {
    const t = await startApp();
    try {
      const a = await t.team(1);
      const b = await t.team(1);
      const target = await t.user({ skills: ['design'] });
      const before = await a.leader.get(`/api/hackathons/${t.hid}/suggestions`);
      expect(before.body.suggestions.map((s) => s.user.id)).toContain(target.id);

      await target.post('/api/invites/redeem', { code: b.code });

      const after = await a.leader.get(`/api/hackathons/${t.hid}/suggestions`);
      expect(after.body.suggestions.map((s) => s.user.id)).not.toContain(target.id);
    } finally {
      await t.close();
    }
  });
});

describe('idempotency record', () => {
  it('is committed together with the change it describes', async () => {
    const t = await startApp();
    try {
      const team = await t.team(1);
      const u = await t.user();
      const res = await u.post('/api/invites/redeem', { code: team.code }).set('Idempotency-Key', 'atomic-1');
      expect(res.status).toBe(200);

      const record = await t.ctx.idempotencyKeys.findOne({ _id: `${u.id}|POST /api/invites/redeem|atomic-1` });
      expect(record).toMatchObject({ state: 'done', status: 200 });
      expect(record.body.team.id).toBe(team.id);
      expect(record.body.team.memberCount).toBe(2);
    } finally {
      await t.close();
    }
  });
});
