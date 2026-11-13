// Capacity probes against ONE Node process with the rate limiters raised, to find where it bends.
//   node scripts/capacity.js            (uses the database in .env; creates throwaway "cap-…" accounts)
// What it measures: signup bursts (argon2 is CPU-bound), N people racing for one seat, N open live-update
// connections (memory, fan-out time), and the suggestions endpoint (which scores every user per request).
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import autocannon from 'autocannon';
import { loadEnvFile } from '../src/config.js';

loadEnvFile();
const PORT = 4200;
const base = `http://127.0.0.1:${PORT}`;
const huge = '1000000000';
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'silent', NODE_ENV: 'production', RATE_LIMIT_MAX: huge, AUTH_RATE_LIMIT_MAX: huge, REDEEM_RATE_LIMIT_IP_MAX: huge, REDEEM_RATE_LIMIT_USER_MAX: huge },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const rssMb = () => Math.round(Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${server.pid}).WorkingSet64`]).toString()) / 1048576);
const ms = (t) => Math.round(performance.now() - t);
const run = randomBytes(3).toString('hex');
const password = randomBytes(12).toString('base64url');
const out = { machine: `${os.cpus()[0].model.trim()}, ${os.cpus().length} threads`, node: process.version };

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

async function signup(n) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `cap-${run}-${n}@example.com`, password, displayName: `Cap ${n}`, skills: ['backend', 'ml'], timezone: 'UTC' }),
  });
  if (res.status !== 201) throw new Error(`signup ${n}: ${res.status}`);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  return { cookie, post: (path, body = {}) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) }) };
}

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    if (i > 100) throw new Error('server did not start');
    await sleep(100);
  }
  const meta = await (await fetch(`${base}/api/meta`)).json();
  const hid = meta.hackathon.id;
  out.idleRssMb = rssMb();

  // 1. signup burst: 300 accounts, 64 in flight
  let t = performance.now();
  const users = await pool(Array.from({ length: 300 }, (_, i) => i), 64, signup);
  const signupMs = ms(t);
  out.signup = { accounts: 300, inFlight: 64, totalMs: signupMs, perSecond: Math.round(300 / (signupMs / 1000)) };

  // 2. contention: N people race for the last seat on one team (fresh accounts each round: nobody can be on two teams)
  out.race = [];
  for (const count of [50, 100, 250]) {
    // fresh accounts for each round so nobody is already on a team
    const fresh = await pool(Array.from({ length: count + 3 }, (_, i) => `r${count}-${i}`), 64, signup);
    const leader = fresh[0];
    const created = await (await leader.post(`/hackathons/${hid}/teams`, { name: `Cap race ${run}-${count}` })).json();
    const code = created.invite.code;
    for (const u of fresh.slice(1, 3)) if ((await u.post('/invites/redeem', { code })).status !== 200) throw new Error('fill failed');
    const start = performance.now();
    const res = await Promise.all(fresh.slice(3).map(async (u) => {
      const r = await u.post('/invites/redeem', { code });
      return r.status === 200 ? 'ok' : (await r.json()).error.code;
    }));
    const tally = res.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
    const team = await (await fetch(`${base}/api/teams/${created.team.id}`, { headers: { cookie: leader.cookie } })).json();
    out.race.push({ racers: count, ms: ms(start), tally, memberCount: team.team.memberCount, maxSize: team.team.maxSize, memberRows: team.members.length });
  }

  // 3. open live-update connections, then fan one event out to all of them
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const target = Number(process.env.CAP_SSE ?? 10000);
  let open = 0;
  let gotEvent = 0;
  let firstAt = 0;
  let lastAt = 0;
  const sockets = [];
  t = performance.now();
  for (let batch = 0; batch < target; batch += 500) {
    await Promise.all(Array.from({ length: Math.min(500, target - batch) }, () => new Promise((resolve) => {
      const req = http.get(`${base}/api/hackathons/${hid}/events`, { agent }, (res) => {
        open++;
        sockets.push(req);
        res.on('data', (chunk) => {
          if (String(chunk).includes('team.created')) {
            gotEvent++;
            lastAt = performance.now();
            if (!firstAt) firstAt = lastAt;
          }
        });
        resolve();
      });
      req.on('error', () => resolve());
    })));
  }
  const connectMs = ms(t);
  await sleep(1000);
  out.sse = { target, open, connectMs, rssMbWithConnections: rssMb(), rssMbPerConnectionKb: Math.round(((rssMb() - out.idleRssMb) * 1024) / Math.max(1, open)) };
  const sender = users[1];
  const sentAt = performance.now();
  await sender.post(`/hackathons/${hid}/teams`, { name: `Cap fanout ${run}` });
  await sleep(3000);
  out.sse.fanOut = { delivered: gotEvent, ofConnections: open, firstReceiverMs: Math.round(firstAt - sentAt), lastReceiverMs: Math.round(lastAt - sentAt) };
  for (const s of sockets) s.destroy();

  // 4. suggestions: scores every user in memory, per request
  const cookie = users[2].cookie;
  const bench = await autocannon({ url: `${base}/api/hackathons/${hid}/suggestions`, connections: 20, duration: 8, headers: { cookie } });
  out.suggestions = { connections: 20, rps: Math.round(bench.requests.average), p50Ms: bench.latency.p50, p99Ms: bench.latency.p99, non2xx: bench.non2xx, errors: bench.errors };

  // 5. board with cache off is covered in LOAD_TEST.md; here: peak memory after all of it
  out.peakRssMbAfter = rssMb();
  console.log(JSON.stringify(out, null, 2));
} finally {
  server.kill();
}
