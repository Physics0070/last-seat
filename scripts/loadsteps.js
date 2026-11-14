// Load test in steps (for example 10, 50 and 100 concurrent users) against a running instance.
// Usage: node scripts/loadsteps.js <base url> <label>
//   node scripts/loadsteps.js http://localhost:4000 local
//   node scripts/loadsteps.js https://example.onrender.com remote
// Each virtual user loops over the board (first page, a page 20 cursors deep, a skill-filtered page). Two passes per
// step: "paced" (each user about one request per second, like a person refreshing) and "flat out" (no pause: stress).
// Two latencies are recorded for every response:
//   client: the full round trip measured here, network included;
//   server: the `app` entry of the Server-Timing header, the time spent inside the server for that request.
// The server figure is what a client next to the server would see, minus its own network round trip.
// Writes docs/loadtest/<label>.json (raw summary) and prints a Markdown table. Nothing is edited by hand.
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { loadEnvFile } from '../src/config.js';

loadEnvFile();
const env = z
  .object({
    LOADTEST_STEPS: z.string().regex(/^\d+(,\d+)*$/),
    LOADTEST_DURATION_SECONDS: z.coerce.number().int().min(1),
    LOADTEST_P95_TARGET_MS: z.coerce.number().min(1),
  })
  .parse(process.env);
const [base, label] = process.argv.slice(2);
if (!base || !label) throw new Error('usage: node scripts/loadsteps.js <base url> <label>');
const steps = env.LOADTEST_STEPS.split(',').map(Number);

const { hackathon } = await (await fetch(`${base}/api/meta`)).json();
const board = `/api/hackathons/${hackathon.id}/teams`;
let cursor;
for (let i = 0; i < 20; i++) {
  const page = await (await fetch(`${base}${board}${cursor ? `?cursor=${cursor}` : ''}`)).json();
  if (!page.nextCursor) break;
  cursor = page.nextCursor;
}
const paths = [board, cursor ? `${board}?cursor=${cursor}` : board, `${board}?skill=design`];

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

async function pass(users, paced) {
  const client = [];
  const server = [];
  const codes = {};
  let failed = 0;
  const end = Date.now() + env.LOADTEST_DURATION_SECONDS * 1000;
  async function user(n) {
    // Spread the paced users over the first second so they do not all fire on the same tick.
    if (paced) await sleep((n / users) * 1000);
    for (let i = n; Date.now() < end; i++) {
      const started = performance.now();
      try {
        const res = await fetch(`${base}${paths[i % paths.length]}`);
        await res.arrayBuffer();
        const took = performance.now() - started;
        codes[res.status] = (codes[res.status] ?? 0) + 1;
        if (res.status !== 200) failed++;
        client.push(took);
        const app = /(?:^|,\s*)app;dur=([\d.]+)/.exec(res.headers.get('server-timing') ?? '');
        if (app) server.push(Number(app[1]));
        if (paced) await sleep(Math.max(0, 1000 - took));
      } catch {
        failed++;
        codes.network = (codes.network ?? 0) + 1;
      }
    }
  }
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: users }, (_, n) => user(n)));
  const seconds = (performance.now() - startedAt) / 1000;
  client.sort((a, b) => a - b);
  server.sort((a, b) => a - b);
  return {
    users,
    mode: paced ? 'paced' : 'flat out',
    requests: client.length,
    rps: round(client.length / seconds),
    failed,
    codes,
    client: { p50: round(pct(client, 50)), p95: round(pct(client, 95)), p99: round(pct(client, 99)), max: round(client.at(-1) ?? null) },
    server: { p50: round(pct(server, 50)), p95: round(pct(server, 95)), p99: round(pct(server, 99)), max: round(server.at(-1) ?? null), samples: server.length },
  };
}

const results = [];
for (const users of steps) {
  for (const paced of [true, false]) {
    const r = await pass(users, paced);
    results.push(r);
    console.error(`${label} ${users} users ${r.mode}: ${r.requests} req, client p95 ${r.client.p95} ms, server p95 ${r.server.p95} ms, failed ${r.failed}`);
  }
}

mkdirSync('docs/loadtest', { recursive: true });
const meta = { label, base, at: new Date().toISOString(), durationSeconds: env.LOADTEST_DURATION_SECONDS, p95TargetMs: env.LOADTEST_P95_TARGET_MS, paths: ['first page', 'page 20 cursors deep', '?skill=design'] };
writeFileSync(`docs/loadtest/${label}.json`, JSON.stringify({ ...meta, results }, null, 2) + '\n');

const verdict = (p95, failed) => (p95 !== null && p95 < env.LOADTEST_P95_TARGET_MS && failed === 0 ? 'PASS' : 'FAIL');
const row = (r) =>
  `| ${r.users} | ${r.mode} | ${r.requests} | ${r.rps} | ${r.client.p50} | ${r.client.p95} | ${r.client.p99} | ${r.server.p50} | ${r.server.p95} | ${r.server.p99} | ${r.failed} | ${verdict(r.client.p95, r.failed)} / ${verdict(r.server.p95, r.failed)} |`;
console.log(`| users | mode | requests | req/s | client p50 | client p95 | client p99 | server p50 | server p95 | server p99 | failed | client / server vs p95 < ${env.LOADTEST_P95_TARGET_MS} ms |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${results.map(row).join('\n')}`);
