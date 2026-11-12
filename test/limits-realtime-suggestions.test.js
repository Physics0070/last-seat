import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scoreMatch, utcOffsetMinutes } from '../src/suggestions.js';
import { startApp } from './helpers.js';

describe('invite brute-force protection', () => {
  it('limits redemption attempts per user', async () => {
    const t = await startApp({ REDEEM_RATE_LIMIT_USER_MAX: '3' });
    try {
      const [attacker, bystander] = await t.users(2);
      const guess = () => attacker.post('/api/invites/redeem', { code: 'AAAA-AAAA-AAAA-AAAA-AAAA' });
      const results = [];
      for (let i = 0; i < 5; i++) results.push((await guess()).status);
      expect(results).toEqual([404, 404, 404, 429, 429]);

      const blocked = await guess();
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(blocked.headers['ratelimit']).toBeDefined();
      // The limit is per user: someone else on the same IP is unaffected.
      expect((await bystander.post('/api/invites/redeem', { code: 'AAAA-AAAA-AAAA-AAAA-AAAA' })).status).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('limits redemption attempts per IP across accounts', async () => {
    const t = await startApp({ REDEEM_RATE_LIMIT_IP_MAX: '4' });
    try {
      const accounts = await t.users(6);
      const results = [];
      for (const u of accounts) results.push((await u.post('/api/invites/redeem', { code: 'BBBB-BBBB-BBBB-BBBB-BBBB' })).status);
      expect(results).toEqual([404, 404, 404, 404, 429, 429]);
    } finally {
      await t.close();
    }
  });

  it('limits login attempts', async () => {
    const t = await startApp({ AUTH_RATE_LIMIT_MAX: '2' });
    try {
      const login = () => t.anon.post('/api/auth/login').send({ email: 'a@example.com', password: 'guess-guess' });
      expect([(await login()).status, (await login()).status, (await login()).status]).toEqual([401, 401, 429]);
    } finally {
      await t.close();
    }
  });
});

describe('server-sent events', () => {
  let t;
  beforeAll(async () => {
    t = await startApp({ SSE_REPLAY_BUFFER: '5' });
  });
  afterAll(() => t.close());

  /** Opens the stream and collects parsed frames until `count` data events arrive. */
  async function listen(count, lastEventId) {
    const controller = new AbortController();
    const res = await fetch(`${t.url}/api/hackathons/${t.hid}/events`, {
      signal: controller.signal,
      headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {},
    });
    const frames = [];
    const done = (async () => {
      const decoder = new TextDecoder();
      let text = '';
      for await (const chunk of res.body) {
        text += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = text.indexOf('\n\n')) !== -1) {
          const lines = text.slice(0, end).split('\n');
          text = text.slice(end + 2);
          const field = (name) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          if (field('event') === 'reset') frames.push({ reset: true });
          else if (field('data')) frames.push({ id: field('id'), ...JSON.parse(field('data')) });
          if (frames.length >= count) {
            controller.abort();
            return frames;
          }
        }
      }
      return frames;
    })().catch((err) => {
      if (err.name === 'AbortError') return frames;
      throw err;
    });
    return { res, done };
  }

  it('pushes join, leader change, removal and deletion to every listener', async () => {
    const stream = await listen(5);
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream');

    const team = await t.team(2);
    await team.leader.post(`/api/teams/${team.id}/leave`);
    await team.others[0].post(`/api/teams/${team.id}/leave`);

    const frames = await stream.done;
    expect(frames.map((f) => f.type)).toEqual(['team.created', 'member.joined', 'member.left', 'leader.changed', 'team.deleted']);
    expect(frames[1]).toMatchObject({ teamId: team.id, userId: team.others[0].id, team: { memberCount: 2, status: 'formed' } });
    expect(frames[3]).toMatchObject({ userId: team.others[0].id, team: { leaderId: team.others[0].id } });
    expect(frames.every((f) => /^[0-9a-f]{8}-\d+$/.test(f.id))).toBe(true);
  });

  it('announces request activity without revealing who asked', async () => {
    const team = await t.team(1);
    const applicant = await t.user();
    const stream = await listen(3);
    const { body } = await applicant.post(`/api/teams/${team.id}/requests`, {});
    await team.leader.post(`/api/requests/${body.request.id}/accept`);

    const frames = await stream.done;
    expect(frames.map((f) => f.type)).toEqual(['request.created', 'member.joined', 'request.accepted']);
    expect(frames[0]).not.toHaveProperty('userId');
  });

  it('replays missed events after a reconnect with Last-Event-ID', async () => {
    const first = await listen(1);
    const team = await t.team(1);
    const [seen] = await first.done;

    // Two events happen while the client is disconnected.
    const u = await t.user();
    await u.post('/api/invites/redeem', { code: team.code });
    await u.post(`/api/teams/${team.id}/leave`);

    const replay = await (await listen(2, seen.id)).done;
    expect(replay.map((f) => f.type)).toEqual(['member.joined', 'member.left']);
    expect(Number(replay[0].id.split('-')[1])).toBe(Number(seen.id.split('-')[1]) + 1);
  });

  it('sends "reset" when the gap is no longer in the buffer or the id is from another boot', async () => {
    const first = await listen(1);
    const team = await t.team(1);
    const [seen] = await first.done;
    // Buffer holds 5 events; push 6 more so the client's position falls out of it.
    for (let i = 0; i < 3; i++) {
      const u = await t.user();
      await u.post('/api/invites/redeem', { code: team.code });
      await u.post(`/api/teams/${team.id}/leave`);
    }
    expect(await (await listen(1, seen.id)).done).toEqual([{ reset: true }]);
    expect(await (await listen(1, 'deadbeef-3')).done).toEqual([{ reset: true }]);
  });

  it('does not publish events for a mutation that failed', async () => {
    const team = await t.team(4);
    const u = await t.user();
    const stream = await listen(1);
    await u.post('/api/invites/redeem', { code: team.code });
    await team.leader.del(`/api/teams/${team.id}/members/${team.others[0].id}`);
    const [frame] = await stream.done;
    expect(frame.type).toBe('member.removed');
  });
});

describe('suggestion scoring (pure)', () => {
  const cfg = { SUGGEST_SKILL_WEIGHT: 0.6, SUGGEST_TZ_WEIGHT: 0.4, SUGGEST_SKILL_TARGET: 3, SUGGEST_WORKDAY_HOURS: 8 };
  const group = (skills, offsets, lookingFor = []) => ({ skills: new Set(skills), offsets, lookingFor: new Set(lookingFor) });
  const person = (skills, utcOffset) => ({ skills, utcOffsetMinutes: utcOffset });

  it('scores 0 skill for someone who brings nothing new and 1 for three new skills', () => {
    const g = group(['frontend', 'backend'], [0]);
    expect(scoreMatch(person(['frontend'], 0), g, cfg).breakdown.skill).toBe(0);
    expect(scoreMatch(person(['design', 'ml', 'data'], 0), g, cfg).breakdown).toMatchObject({ skill: 1, newSkills: ['design', 'ml', 'data'] });
  });

  it('counts a skill the team asked for twice', () => {
    const asked = scoreMatch(person(['design'], 0), group(['backend'], [0], ['design']), cfg);
    const notAsked = scoreMatch(person(['design'], 0), group(['backend'], [0]), cfg);
    expect(asked.breakdown).toMatchObject({ skill: 0.667, wantedSkills: ['design'] });
    expect(notAsked.breakdown).toMatchObject({ skill: 0.333, wantedSkills: [] });
  });

  it('time-zone overlap falls linearly to zero at a workday apart and wraps around the date line', () => {
    const g = group([], [0]);
    expect(scoreMatch(person([], 0), g, cfg).breakdown).toMatchObject({ timezone: 1, overlapHours: 8 });
    expect(scoreMatch(person([], 240), g, cfg).breakdown).toMatchObject({ timezone: 0.5, overlapHours: 4 });
    expect(scoreMatch(person([], 600), g, cfg).breakdown.timezone).toBe(0);
    // UTC+12 and UTC-11 are one hour apart, not 23.
    expect(scoreMatch(person([], 720), group([], [-660]), cfg).breakdown.overlapHours).toBe(7);
  });

  it('averages overlap across team members and combines with the configured weights', () => {
    const result = scoreMatch(person(['design', 'ml', 'data'], 0), group(['backend'], [0, 480]), cfg);
    expect(result.breakdown.overlapHours).toBe(4);
    expect(result.score).toBe(0.8); // 0.6 * 1 + 0.4 * 0.5
  });

  it('reads UTC offsets from IANA names', () => {
    expect(utcOffsetMinutes('Asia/Kolkata')).toBe(330);
    expect(utcOffsetMinutes('UTC')).toBe(0);
    expect(utcOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
  });
});

describe('GET /hackathons/:id/suggestions', () => {
  let t;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  it('ranks unteamed people for the caller\'s team, best complement first, excluding teamed users', async () => {
    const team = await t.team(2, { name: 'Needs design', lookingFor: ['design'] });
    const ideal = await t.user({ displayName: 'Ideal', skills: ['design', 'ml'], timezone: 'UTC' });
    const farAway = await t.user({ displayName: 'Far', skills: ['design', 'ml'], timezone: 'Pacific/Auckland' });
    const redundant = await t.user({ displayName: 'Same', skills: ['backend'], timezone: 'UTC' });
    const other = await t.team(1);

    const { status, body } = await team.leader.get(`/api/hackathons/${t.hid}/suggestions`);

    expect(status).toBe(200);
    expect(body.for).toEqual({ teamId: team.id });
    const ids = body.suggestions.map((s) => s.user.id);
    expect(ids.slice(0, 3)).toEqual([ideal.id, farAway.id, redundant.id]);
    expect(ids).not.toContain(other.leader.id);
    expect(ids).not.toContain(team.leader.id);
    expect(body.suggestions[0]).toMatchObject({ score: 1, breakdown: { newSkills: ['design', 'ml'], wantedSkills: ['design'], overlapHours: 8 } });
    expect(body.suggestions[0].user).not.toHaveProperty('email');
  });

  it('ranks open teams for a user without one', async () => {
    const solo = await t.user({ skills: ['design'], timezone: 'UTC' });
    const { status, body } = await solo.get(`/api/hackathons/${t.hid}/suggestions?kind=teams`);
    expect(status).toBe(200);
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0].team.name).toBe('Needs design');
    expect(body.suggestions.every((s) => s.team.openSeats > 0)).toBe(true);
  });
});
