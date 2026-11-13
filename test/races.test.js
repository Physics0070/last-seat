import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, statuses } from './helpers.js';

// MAX_TEAM_SIZE is 4 in .env.example, so a team of 3 has exactly one free seat.
let t;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const codes = (responses) => responses.map((r) => r.body.error?.code ?? 'ok').sort();

describe('seat claiming under contention', () => {
  it.each([1, 2, 3, 4, 5])('50 users race for the last seat: exactly one wins (round %i)', async () => {
    const team = await t.team(3);
    const racers = await t.users(50);

    const responses = await Promise.all(racers.map((u) => u.post('/api/invites/redeem', { code: team.code })));

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const losers = responses.filter((r) => r.status !== 200);
    expect(losers).toHaveLength(49);
    for (const r of losers) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('team_full');
    }

    const { doc, rows } = await t.invariants(team.id);
    expect(doc.memberCount).toBe(doc.maxSize);
    expect(doc.isOpen).toBe(false);
    expect(rows).toBe(doc.maxSize);
  });

  it('100 users race for the last seat: exactly one wins and the database agrees', async () => {
    const team = await t.team(3);
    const racers = await t.users(100);

    const responses = await Promise.all(racers.map((u) => u.post('/api/invites/redeem', { code: team.code })));

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409 && r.body.error.code === 'team_full')).toHaveLength(99);
    const { doc, memberships } = await t.invariants(team.id);
    expect(doc.memberCount).toBe(doc.maxSize);
    expect(memberships).toHaveLength(doc.maxSize);
    const winner = racers[responses.findIndex((r) => r.status === 200)];
    expect(memberships.map((m) => String(m.userId))).toContain(winner.id);
    // nobody else was left half-joined anywhere
    expect(await t.ctx.memberships.countDocuments({ userId: { $in: racers.map((u) => new ObjectId(u.id)) } })).toBe(1);
  });

  it('a double-click joins once', async () => {
    const team = await t.team(1);
    const u = await t.user();

    const responses = await Promise.all([1, 2, 3].map(() => u.post('/api/invites/redeem', { code: team.code })));

    expect(codes(responses)).toEqual(['already_on_team', 'already_on_team', 'ok']);
    const { memberCount, rows } = await t.invariants(team.id);
    expect(memberCount).toBe(2);
    expect(rows).toBe(2);
  });

  it('a user racing to join two teams lands on exactly one, and the other seat is released', async () => {
    const [a, b] = await Promise.all([t.team(1), t.team(1)]);
    const u = await t.user();

    const responses = await Promise.all([a, b].map((team) => u.post('/api/invites/redeem', { code: team.code })));

    expect(codes(responses)).toEqual(['already_on_team', 'ok']);
    const [ia, ib] = await Promise.all([t.invariants(a.id), t.invariants(b.id)]);
    expect(ia.memberCount + ib.memberCount).toBe(3);
    expect(ia.rows + ib.rows).toBe(3);
    expect(ia.memberCount).toBe(ia.rows);
    expect(ib.memberCount).toBe(ib.rows);
  });

  it('accepting two requests at once for the last seat seats one and leaves the other pending', async () => {
    const team = await t.team(3);
    const applicants = await t.users(2);
    const requests = await Promise.all(applicants.map((u) => u.post(`/api/teams/${team.id}/requests`, {})));
    expect(statuses(requests)).toEqual([201, 201]);

    const responses = await Promise.all(requests.map((r) => team.leader.post(`/api/requests/${r.body.request.id}/accept`)));

    expect(codes(responses)).toEqual(['ok', 'team_full']);
    const { memberCount, rows } = await t.invariants(team.id);
    expect(memberCount).toBe(4);
    expect(rows).toBe(4);
    const stored = await t.ctx.joinRequests.find({ teamId: (await t.invariants(team.id)).doc._id }).toArray();
    expect(stored.map((r) => r.status).sort()).toEqual(['accepted', 'pending']);
  });

  it('accepting the same request twice at once adds the member once', async () => {
    const team = await t.team(1);
    const applicant = await t.user();
    const { body } = await applicant.post(`/api/teams/${team.id}/requests`, {});

    const responses = await Promise.all([1, 2].map(() => team.leader.post(`/api/requests/${body.request.id}/accept`)));

    expect(codes(responses)).toEqual(['ok', 'request_not_pending']);
    const { memberCount, rows } = await t.invariants(team.id);
    expect(memberCount).toBe(2);
    expect(rows).toBe(2);
  });

  it.each([1, 2, 3])('leader leaves while two people join: count, rows and leader stay consistent (round %i)', async () => {
    const team = await t.team(2);
    const joiners = await t.users(2);

    const responses = await Promise.all([
      team.leader.post(`/api/teams/${team.id}/leave`),
      ...joiners.map((u) => u.post('/api/invites/redeem', { code: team.code })),
    ]);

    expect(statuses(responses)).toEqual([200, 200, 200]);
    const { doc, memberships } = await t.invariants(team.id);
    expect(doc.memberCount).toBe(3);
    expect(memberships).toHaveLength(3);
    // Leadership went to the longest-standing remaining member, who must still be a member.
    expect(String(doc.leaderId)).toBe(team.others[0].id);
    expect(memberships.map((m) => String(m.userId))).toContain(String(doc.leaderId));
  });

  it.each([1, 2, 3])('last member leaves while someone joins: either outcome is consistent (round %i)', async () => {
    const team = await t.team(1);
    const joiner = await t.user();

    const [leave, join] = await Promise.all([
      team.leader.post(`/api/teams/${team.id}/leave`),
      joiner.post('/api/invites/redeem', { code: team.code }),
    ]);

    expect(leave.status).toBe(200);
    const { doc, memberships } = await t.invariants(team.id);
    if (join.status === 200) {
      // The join committed first: the team survives and the joiner inherits it.
      expect(doc.memberCount).toBe(1);
      expect(memberships.map((m) => String(m.userId))).toEqual([joiner.id]);
      expect(String(doc.leaderId)).toBe(joiner.id);
    } else {
      // The leave committed first: the team is gone and nobody is stranded in it.
      expect(join.status).toBe(404);
      expect(join.body.error.code).toBe('invite_invalid');
      expect(doc).toBeNull();
      expect(memberships).toHaveLength(0);
    }
  });
});
