// The headline scenario against any running instance (local or deployed): N people press "join" on a team with
// exactly one free seat at the same instant.
//   node scripts/race.js https://your-app.example 50
// It creates throwaway accounts (live-…@example.com) through the public API, politely waiting out the signup rate
// limit, then fires every join at once with an Idempotency-Key and reports what came back and what the team looks like.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const [base, countArg] = process.argv.slice(2);
const racers = Number(countArg);
if (!base || !Number.isInteger(racers) || racers < 2) throw new Error('usage: node scripts/race.js <base url> <racers, at least 2>');

const run = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
let throttled = 0;

async function signup(name) {
  for (;;) {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `live-${name}-${run}@example.com`, password, displayName: `Live ${name}`, skills: ['backend'], timezone: 'UTC' }),
    });
    if (res.status === 429) {
      throttled++;
      const wait = Number(/t=(\d+)/.exec(res.headers.get('ratelimit') ?? '')?.[1] ?? 5);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status !== 201) throw new Error(`signup ${name}: ${res.status} ${await res.text()}`);
    const cookie = res.headers.getSetCookie()[0].split(';')[0];
    const { user } = await res.json();
    return {
      id: user.id,
      get: (path) => fetch(`${base}/api${path}`, { headers: { cookie } }),
      post: (path, body = {}) =>
        fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) }),
    };
  }
}

const meta = await (await fetch(`${base}/api/meta`)).json();
const { maxTeamSize } = meta.hackathon;
console.error(`creating ${racers + maxTeamSize - 1} accounts (the signup limit is per minute, so this can take a while)...`);
const leader = await signup('leader');
const created = await (await leader.post(`/hackathons/${meta.hackathon.id}/teams`, { name: `Race ${run}` })).json();
const code = created.invite.code;
// fill the team until exactly one seat is free
for (let i = 0; i < maxTeamSize - 2; i++) {
  const filler = await signup(`fill${i}`);
  if ((await filler.post('/invites/redeem', { code })).status !== 200) throw new Error('could not fill the team');
}
const contenders = [];
for (let i = 0; i < racers; i++) contenders.push(await signup(`racer${i}`));

console.error('ready: firing all joins at once');
const started = performance.now();
const results = await Promise.all(
  contenders.map(async (u) => {
    const sent = performance.now();
    const res = await u.post('/invites/redeem', { code });
    return { ms: Math.round(performance.now() - sent), status: res.status, code: res.status === 200 ? 'ok' : (await res.json()).error.code };
  }),
);
const totalMs = Math.round(performance.now() - started);

const tally = {};
for (const r of results) tally[r.code] = (tally[r.code] ?? 0) + 1;
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const team = await (await leader.get(`/teams/${created.team.id}`)).json();
const verdict = {
  racers,
  base,
  tally,
  responseMs: { fastest: times[0], median: times[times.length >> 1], slowest: times.at(-1), allTogether: totalMs },
  team: { memberCount: team.team.memberCount, maxSize: team.team.maxSize, memberRows: team.members.length },
  signupRetriesDueToRateLimit: throttled,
  exactlyOneWinner: tally.ok === 1 && team.team.memberCount === team.team.maxSize && team.members.length === team.team.maxSize,
  anyServerError: results.some((r) => r.status >= 500),
};
console.log(JSON.stringify(verdict, null, 2));
process.exitCode = verdict.exactlyOneWinner && !verdict.anyServerError ? 0 : 1;
