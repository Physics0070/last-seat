import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.js';

let t;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

describe('Idempotency-Key', () => {
  it('a retried create-team returns the original response and creates one team', async () => {
    const u = await t.user();
    const send = () => u.post(`/api/hackathons/${t.hid}/teams`, { name: 'Once' }).set('Idempotency-Key', 'create-1');

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await t.ctx.teams.countDocuments({ name: 'Once' })).toBe(1);
  });

  it('a retried join returns the original 200 instead of "already on a team"', async () => {
    const team = await t.team(1);
    const u = await t.user();
    const send = () => u.post('/api/invites/redeem', { code: team.code }).set('Idempotency-Key', 'join-1');

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect((await t.invariants(team.id)).rows).toBe(2);
  });

  it('20 concurrent duplicates run the handler once', async () => {
    const u = await t.user();
    const send = () => u.post(`/api/hackathons/${t.hid}/teams`, { name: 'Burst' }).set('Idempotency-Key', 'burst-1');

    const responses = await Promise.all(Array.from({ length: 20 }, send));

    // Each duplicate either waited behind the lock (409 in progress) or arrived after and got the replay.
    const created = responses.filter((r) => r.status === 201);
    const executed = created.filter((r) => r.headers['idempotency-replayed'] !== 'true');
    expect(executed).toHaveLength(1);
    for (const r of responses.filter((r) => r.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('idempotency_in_progress');
      expect(r.headers['retry-after']).toBe('1');
    }
    expect(await t.ctx.teams.countDocuments({ name: 'Burst' })).toBe(1);

    const later = await send();
    expect(later.status).toBe(201);
    expect(later.headers['idempotency-replayed']).toBe('true');
    expect(later.body).toEqual(executed[0].body);
  });

  it('error responses are replayed too', async () => {
    const team = await t.team(4);
    const u = await t.user();
    const send = () => u.post('/api/invites/redeem', { code: team.code }).set('Idempotency-Key', 'full-1');

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(409);
    expect(retry.status).toBe(409);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
  });

  it('rejects a key reused for a different request', async () => {
    const u = await t.user();
    await u.post(`/api/hackathons/${t.hid}/teams`, { name: 'First' }).set('Idempotency-Key', 'reuse-1');

    const res = await u.post(`/api/hackathons/${t.hid}/teams`, { name: 'Second' }).set('Idempotency-Key', 'reuse-1');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_reused');
  });

  it('keys are scoped per user', async () => {
    const [a, b] = await t.users(2);
    const send = (u) => u.post(`/api/hackathons/${t.hid}/teams`, { name: 'Scoped' }).set('Idempotency-Key', 'shared-key');

    const [ra, rb] = [await send(a), await send(b)];

    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(rb.body.team.id).not.toBe(ra.body.team.id);
  });

  it('a crashed attempt does not block the key forever: the lock expires and the retry runs', async () => {
    const u = await t.user();
    const path = `/api/hackathons/${t.hid}/teams`;
    const send = () => u.post(path, { name: 'Recovered' }).set('Idempotency-Key', 'crash-1');
    const first = await send();
    // Simulate a process that died mid-request: the record is stuck in "processing".
    await t.ctx.idempotencyKeys.updateOne(
      { _id: `${u.id}:crash-1` },
      { $set: { state: 'processing', lockedUntil: new Date(Date.now() + 60_000) }, $unset: { status: '', body: '' } },
    );

    const blocked = await send();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('idempotency_in_progress');

    await t.ctx.idempotencyKeys.updateOne({ _id: `${u.id}:crash-1` }, { $set: { lockedUntil: new Date(0) } });
    const retried = await send();

    // The handler ran again, and the unique membership index stopped a second team.
    expect(first.status).toBe(201);
    expect(retried.status).toBe(409);
    expect(retried.body.error.code).toBe('already_on_team');
    expect(await t.ctx.teams.countDocuments({ name: 'Recovered' })).toBe(1);
  });

  it('a retried signup creates one account and the replay still signs the user in', async () => {
    const body = { email: 'once@example.com', password: 'long enough pw', displayName: 'Once', skills: ['ml'], timezone: 'UTC' };
    const send = (b = body) => t.anon.post('/api/auth/signup').set('Idempotency-Key', 'signup-1').send(b);

    const first = await send();
    const retry = await send();
    const different = await send({ ...body, displayName: 'Someone else' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(different.status).toBe(422);
    expect(await t.ctx.users.countDocuments({ email: 'once@example.com' })).toBe(1);

    const cookie = retry.headers['set-cookie'][0].split(';')[0];
    expect((await t.anon.get('/api/me').set('Cookie', cookie)).body.user.id).toBe(first.body.user.id);
    // The stored fingerprint is keyed, so the password cannot be recovered from the record.
    const record = await t.ctx.idempotencyKeys.findOne({ _id: 'anon:signup-1' });
    expect(JSON.stringify(record)).not.toContain('long enough pw');
  });

  it('rejects a malformed key', async () => {
    const u = await t.user();
    const res = await u.post(`/api/hackathons/${t.hid}/teams`, { name: 'Bad key' }).set('Idempotency-Key', 'x'.repeat(200));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_idempotency_key');
  });
});
