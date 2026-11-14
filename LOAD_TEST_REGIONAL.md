# Load test: what a client in the server's region would see

**Read this first.** There is no load-generating client in Singapore. These numbers are **server-side timings** from
the same run as [LOAD_TEST_REMOTE.md](LOAD_TEST_REMOTE.md) (2026-11-14T06:18Z, raw data in
[docs/loadtest/remote.json](docs/loadtest/remote.json)), not a second test from a regional machine.

Every API response carries a `Server-Timing` header. Its `app` entry is the time from the request reaching the
Node process to the response being written. A client in the same region would see this time plus its own round trip
to the server (typically a few milliseconds inside one cloud region) plus Render's proxy. That makes these numbers a
**lower bound** for a regional client, not a measurement of one.

| users | mode | samples | server p50 | server p95 | server p99 | server max | failed | server p95 < 200 ms |
|---:|---|---:|---:|---:|---:|---:|---:|---|
| 10 | paced | 197 | 0.0 ms | 66.3 ms | 75.9 ms | 78.8 ms | 0 | PASS |
| 10 | flat out | 1,484 | 0.0 ms | 62.6 ms | 65.2 ms | 83.4 ms | 0 | PASS |
| 50 | paced | 993 | 0.0 ms | 52.3 ms | 66.5 ms | 71.0 ms | 0 | PASS |
| 50 | flat out | 6,993 | 0.0 ms | 91.0 ms | 97.1 ms | 103.0 ms | 0 | PASS |
| 100 | paced | 1,985 | 0.0 ms | 46.6 ms | 66.7 ms | 168.7 ms | 0 | PASS |
| 100 | flat out | 7,648 | 0.0 ms | 96.6 ms | 102.2 ms | 110.8 ms | 0 | PASS |

## What the numbers mean

- **p50 is a cache hit (under 0.01 ms).** The board page cache answers before any middleware. It lives for 1 s and is
  cleared by every committed change, so a hit is never older than the last write.
- **p95–p99 are cache misses.** These are the requests that actually run the MongoDB query. The database is Atlas M0
  in Mumbai, a different region from the server, so a miss costs a cross-region database round trip plus serialisation
  (the `db` and `ser` entries of the same header split it).
  - Concurrent misses for the same page wait on one in-flight query instead of each running their own.
  - A database in the same region as the server would cut this further. That needs a paid Atlas tier in Singapore, or
    moving the service to Mumbai, which Render does not offer.
- **Under stress the tail grows only to about 100 ms.** Flat out at 100 users, p95 is 96.6 ms: the instance's CPU
  share, not the query, is what saturates (see [LOAD_TEST_REMOTE.md](LOAD_TEST_REMOTE.md)).

## What this does not show

- Latency from a real client in Singapore, including TLS setup and Render's proxy. Measuring that needs a machine in
  the region, for example a small VM in `ap-southeast-1` running
  `node scripts/loadsteps.js https://last-seat-sg.onrender.com regional`.
- Write throughput. Writes are covered by the race tests: 100 users for 1 seat, exactly 1 winner, checked in the
  database by `test/races.test.js` and live by `npm run race -- <url> 100`.
