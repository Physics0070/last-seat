import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './helpers.js';

let t;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const teamsPath = () => `/api/hackathons/${t.hid}/teams`;

describe('authentication', () => {
  it('rejects unauthenticated access to protected routes', async () => {
    const team = await t.team(1);
    const attempts = await Promise.all([
      t.anon.get('/api/me'),
      t.anon.post(teamsPath()).send({ name: 'Nope' }),
      t.anon.post('/api/invites/redeem').send({ code: team.code }),
      t.anon.get(`/api/teams/${team.id}`),
      t.anon.post(`/api/teams/${team.id}/leave`).send({}),
      t.anon.get(`/api/hackathons/${t.hid}/suggestions`),
    ]);
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    }
  });

  it('rejects a forged session cookie', async () => {
    const res = await t.anon.get('/api/me').set('Cookie', 'session=not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('sets an httpOnly SameSite cookie and never returns the password hash', async () => {
    const res = await t.anon
      .post('/api/auth/signup')
      .send({ email: 'Cookie@Example.com', password: 'long enough pw', displayName: 'C', skills: ['design'], timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(res.headers['set-cookie'][0]).toMatch(/SameSite=Lax/);
    expect(res.body.user.email).toBe('cookie@example.com');
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);
  });

  it('logs in with the right password only, with one error for both failure cases', async () => {
    const u = await t.user();
    const ok = await t.anon.post('/api/auth/login').send({ email: u.email, password: 'correct horse battery' });
    const wrong = await t.anon.post('/api/auth/login').send({ email: u.email, password: 'wrong password' });
    const unknown = await t.anon.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong password' });
    expect(ok.status).toBe(200);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
  });

  it('refuses a duplicate email', async () => {
    const u = await t.user();
    const res = await t.anon
      .post('/api/auth/signup')
      .send({ email: u.email.toUpperCase(), password: 'long enough pw', displayName: 'Dup', skills: ['ml'], timezone: 'UTC' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_taken');
  });
});

describe('validation and error format', () => {
  it('rejects unknown fields and reports each problem', async () => {
    const u = await t.user();
    const res = await u.post(teamsPath(), { name: 'x', admin: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed JSON, bad ids, unknown skills and bad time zones without leaking a stack', async () => {
    const u = await t.user();
    const badJson = await u.post(teamsPath()).set('Content-Type', 'application/json').send('{"name":');
    const badId = await u.get('/api/teams/not-an-id');
    const badSkill = await u.post(teamsPath(), { name: 'Skills', lookingFor: ['telepathy'] });
    const badTz = await t.anon
      .post('/api/auth/signup')
      .send({ email: 'tz@example.com', password: 'long enough pw', displayName: 'T', skills: ['ml'], timezone: 'Mars/Olympus' });
    for (const res of [badJson, badId, badSkill, badTz]) {
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js|node_modules/);
    }
    expect(badJson.body.error.code).toBe('invalid_json');
  });

  it('returns 404 in the same format for unknown routes and hackathons', async () => {
    const u = await t.user();
    const route = await u.get('/api/nope');
    const hackathon = await u.get(`/api/hackathons/${new ObjectId()}/teams`);
    expect(route.status).toBe(404);
    expect(hackathon.status).toBe(404);
    expect(hackathon.body.error.code).toBe('hackathon_not_found');
  });
});

describe('team rules', () => {
  it('a new team is "forming" below the minimum and "formed" at it', async () => {
    const team = await t.team(1);
    const before = await team.leader.get(`/api/teams/${team.id}`);
    expect(before.body.team).toMatchObject({ memberCount: 1, minSize: 2, maxSize: 4, status: 'forming', openSeats: 3 });

    const u = await t.user();
    const joined = await u.post('/api/invites/redeem', { code: team.code });
    expect(joined.body.team).toMatchObject({ memberCount: 2, status: 'formed' });
  });

  it('never exceeds the maximum, and a full team leaves the board', async () => {
    const team = await t.team(4, { name: 'Full house' });
    const late = await t.user();

    const res = await late.post('/api/invites/redeem', { code: team.code });
    const request = await late.post(`/api/teams/${team.id}/requests`, {});
    const board = await late.get(`${teamsPath()}?limit=50`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'team_full', details: { teamId: team.id } });
    expect(request.status).toBe(409);
    expect(board.body.items.map((i) => i.id)).not.toContain(team.id);
    expect((await t.invariants(team.id)).rows).toBe(4);
  });

  it('one team per person: cannot create or join a second team', async () => {
    const [a, b] = [await t.team(1), await t.team(1)];
    const create = await a.leader.post(teamsPath(), { name: 'Second' });
    const join = await a.leader.post('/api/invites/redeem', { code: b.code });
    const request = await a.leader.post(`/api/teams/${b.id}/requests`, {});
    for (const res of [create, join, request]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('already_on_team');
    }
  });

  it('the unique index itself rejects a second membership, even bypassing the API', async () => {
    const team = await t.team(1);
    const { doc } = await t.invariants(team.id);
    await expect(
      t.ctx.memberships.insertOne({ hackathonId: doc.hackathonId, teamId: new ObjectId(), userId: doc.leaderId, joinedAt: new Date() }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('cannot request the same team twice or a team you are on', async () => {
    const team = await t.team(2);
    const u = await t.user();
    const first = await u.post(`/api/teams/${team.id}/requests`, { message: 'hi' });
    const again = await u.post(`/api/teams/${team.id}/requests`, {});
    const member = await team.others[0].post(`/api/teams/${team.id}/requests`, {});
    expect(first.status).toBe(201);
    expect(again.body.error.code).toBe('request_exists');
    expect(member.body.error.code).toBe('already_on_team');
  });
});

describe('invite codes', () => {
  it('have at least 50 bits of entropy and are stored only as a hash', async () => {
    const team = await t.team(1);
    const hex = team.code.replaceAll('-', '');
    expect(hex.length * 4).toBeGreaterThanOrEqual(50);
    const { doc } = await t.invariants(team.id);
    expect(JSON.stringify(doc)).not.toContain(hex);
    expect(doc.inviteCodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accept lower case and missing dashes', async () => {
    const team = await t.team(1);
    const u = await t.user();
    const res = await u.post('/api/invites/redeem', { code: team.code.replaceAll('-', '').toLowerCase() });
    expect(res.status).toBe(200);
  });

  it('expire, and unknown and expired codes are indistinguishable', async () => {
    const team = await t.team(1);
    await t.ctx.teams.updateOne({ _id: new ObjectId(team.id) }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
    const u = await t.user();
    const expired = await u.post('/api/invites/redeem', { code: team.code });
    const unknown = await u.post('/api/invites/redeem', { code: 'AAAA-BBBB-CCCC-DDDD-EEEE' });
    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(expired.body.error).toEqual(unknown.body.error);
  });

  it('regenerating invalidates the old code; only the leader may regenerate', async () => {
    const team = await t.team(2);
    const denied = await team.others[0].post(`/api/teams/${team.id}/invite`);
    const regen = await team.leader.post(`/api/teams/${team.id}/invite`);
    const u = await t.user();
    const old = await u.post('/api/invites/redeem', { code: team.code });
    const fresh = await u.post('/api/invites/redeem', { code: regen.body.invite.code });
    expect(denied.status).toBe(403);
    expect(regen.status).toBe(200);
    expect(old.status).toBe(404);
    expect(fresh.status).toBe(200);
  });
});

describe('authorization: leader-only actions', () => {
  it('only the leader can list, accept or decline requests, remove members or read the audit log', async () => {
    const team = await t.team(2);
    const member = team.others[0];
    const outsider = await t.user();
    const applicant = await t.user();
    const { body } = await applicant.post(`/api/teams/${team.id}/requests`, {});
    const rid = body.request.id;

    for (const u of [member, outsider]) {
      const attempts = await Promise.all([
        u.get(`/api/teams/${team.id}/requests`),
        u.post(`/api/requests/${rid}/accept`),
        u.post(`/api/requests/${rid}/decline`),
        u.del(`/api/teams/${team.id}/members/${team.leader.id}`),
        u.get(`/api/teams/${team.id}/audit`),
      ]);
      for (const res of attempts) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('forbidden');
      }
    }
    expect((await t.ctx.joinRequests.findOne({ _id: new ObjectId(rid) })).status).toBe('pending');
    expect((await t.invariants(team.id)).rows).toBe(2);
  });

  it('only the requester can cancel their request', async () => {
    const team = await t.team(1);
    const applicant = await t.user();
    const { body } = await applicant.post(`/api/teams/${team.id}/requests`, {});
    const byLeader = await team.leader.post(`/api/requests/${body.request.id}/cancel`);
    const byOwner = await applicant.post(`/api/requests/${body.request.id}/cancel`);
    expect(byLeader.status).toBe(403);
    expect(byOwner.status).toBe(200);
  });
});

describe('join requests', () => {
  it('accepting seats the requester and cancels their other pending requests', async () => {
    const [a, b] = [await t.team(1), await t.team(1)];
    const applicant = await t.user();
    const toA = await applicant.post(`/api/teams/${a.id}/requests`, {});
    const toB = await applicant.post(`/api/teams/${b.id}/requests`, {});

    const inbox = await a.leader.get(`/api/teams/${a.id}/requests`);
    expect(inbox.body.requests).toHaveLength(1);
    expect(inbox.body.requests[0].user.id).toBe(applicant.id);

    const accepted = await a.leader.post(`/api/requests/${toA.body.request.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.team.memberCount).toBe(2);
    expect((await applicant.get(`/api/hackathons/${t.hid}/me`)).body).toEqual({ teamId: a.id, pendingRequests: [] });

    const late = await b.leader.post(`/api/requests/${toB.body.request.id}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('request_not_pending');
  });

  it('declining leaves the team unchanged and the request cannot be accepted afterwards', async () => {
    const team = await t.team(1);
    const applicant = await t.user();
    const { body } = await applicant.post(`/api/teams/${team.id}/requests`, {});
    const declined = await team.leader.post(`/api/requests/${body.request.id}/decline`);
    const accept = await team.leader.post(`/api/requests/${body.request.id}/accept`);
    expect(declined.status).toBe(200);
    expect(accept.status).toBe(409);
    expect((await t.invariants(team.id)).rows).toBe(1);
  });
});

describe('leaving and removing', () => {
  it('when the leader leaves, leadership passes to the longest-standing member', async () => {
    const team = await t.team(3);
    const res = await team.leader.post(`/api/teams/${team.id}/leave`);
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({ memberCount: 2, leaderId: team.others[0].id });

    // The new leader now holds the leader-only powers; the old one holds none.
    expect((await team.others[0].get(`/api/teams/${team.id}/requests`)).status).toBe(200);
    expect((await team.leader.get(`/api/teams/${team.id}/requests`)).status).toBe(403);
  });

  it('the last member leaving deletes the team and cancels its pending requests', async () => {
    const team = await t.team(1);
    const applicant = await t.user();
    const { body } = await applicant.post(`/api/teams/${team.id}/requests`, {});

    const res = await team.leader.post(`/api/teams/${team.id}/leave`);

    expect(res.status).toBe(200);
    expect(res.body.team).toBeNull();
    expect((await team.leader.get(`/api/teams/${team.id}`)).status).toBe(404);
    expect((await t.ctx.joinRequests.findOne({ _id: new ObjectId(body.request.id) })).status).toBe('cancelled');
    expect((await applicant.post('/api/invites/redeem', { code: team.code })).status).toBe(404);
    // The person who left is free to start again.
    expect((await team.leader.post(teamsPath(), { name: 'Fresh start' })).status).toBe(201);
  });

  it('the leader can remove a member, reopening the seat', async () => {
    const team = await t.team(4);
    const res = await team.leader.del(`/api/teams/${team.id}/members/${team.others[2].id}`);
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({ memberCount: 3, openSeats: 1 });
    const again = await team.leader.del(`/api/teams/${team.id}/members/${team.others[2].id}`);
    expect(again.status).toBe(404);
    const { doc, rows } = await t.invariants(team.id);
    expect(doc.isOpen).toBe(true);
    expect(rows).toBe(3);
  });

  it('leaving a team you are not on is a 404', async () => {
    const team = await t.team(1);
    const u = await t.user();
    const res = await u.post(`/api/teams/${team.id}/leave`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_a_member');
  });
});

describe('audit log', () => {
  it('records every change with actor, target, before/after and request id', async () => {
    const team = await t.team(1);
    const u = await t.user();
    const joined = await u.post('/api/invites/redeem', { code: team.code });
    await team.leader.del(`/api/teams/${team.id}/members/${u.id}`);

    const { body } = await team.leader.get(`/api/teams/${team.id}/audit`);

    expect(body.items.map((e) => e.action)).toEqual(['member.removed', 'member.joined_by_invite', 'team.created']);
    expect(body.items[0]).toMatchObject({ actorId: team.leader.id, targetId: u.id, before: { memberCount: 2 }, after: { memberCount: 1 } });
    expect(body.items[1]).toMatchObject({ actorId: u.id, targetId: u.id, requestId: joined.headers['x-request-id'] });
  });

  it('a failed join writes no audit entry (it is in the same transaction)', async () => {
    const team = await t.team(4);
    const u = await t.user();
    await u.post('/api/invites/redeem', { code: team.code });
    const { body } = await team.leader.get(`/api/teams/${team.id}/audit?limit=50`);
    expect(body.items).toHaveLength(4);
    expect(body.items.some((e) => e.targetId === u.id)).toBe(false);
  });
});

describe('board', () => {
  it('pages with a cursor, newest first, without repeats', async () => {
    const b = await startApp();
    try {
      const created = [];
      for (let i = 0; i < 5; i++) created.push((await b.team(1, { name: `Team ${i}`, lookingFor: i % 2 ? ['design'] : ['ml'] })).id);
      const path = `/api/hackathons/${b.hid}/teams`;

      const p1 = await b.anon.get(`${path}?limit=2`);
      const p2 = await b.anon.get(`${path}?limit=2&cursor=${p1.body.nextCursor}`);
      const p3 = await b.anon.get(`${path}?limit=2&cursor=${p2.body.nextCursor}`);
      const design = await b.anon.get(`${path}?skill=design`);
      const tooBig = await b.anon.get(`${path}?limit=1000`);

      expect([...p1.body.items, ...p2.body.items, ...p3.body.items].map((i) => i.id)).toEqual(created.toReversed());
      expect(p3.body.nextCursor).toBeNull();
      expect(design.body.items.map((i) => i.id)).toEqual([created[3], created[1]]);
      expect(tooBig.status).toBe(400);
    } finally {
      await b.close();
    }
  });

  it('is served by an index scan with no in-memory sort', async () => {
    const plan = await t.ctx.teams
      .find({ hackathonId: t.ctx.hackathon._id, isOpen: true })
      .sort({ _id: -1 })
      .limit(21)
      .explain('queryPlanner');
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(text).toContain('IXSCAN');
    expect(text).not.toContain('COLLSCAN');
    expect(text).not.toMatch(/"stage":"SORT"/);
  });
});
