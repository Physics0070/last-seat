import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { AppError } from './http.js';
import { defaultMetrics } from './metrics.js';
import { requestContext } from './request-context.js';

export async function connectDb(config, log) {
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  const db = client.db(config.MONGODB_DB);
  const ctx = {
    config,
    log,
    client,
    db,
    users: db.collection('users'),
    hackathons: db.collection('hackathons'),
    teams: db.collection('teams'),
    memberships: db.collection('memberships'),
    joinRequests: db.collection('joinRequests'),
    auditLog: db.collection('auditLog'),
    idempotencyKeys: db.collection('idempotencyKeys'),
    metrics: defaultMetrics(),
    // Bumped whenever people or teams change; caches built from that data compare against it.
    poolVersion: 0,
  };
  await ensureIndexes(ctx);
  ctx.hackathon = await ensureHackathon(ctx);
  return ctx;
}

async function ensureIndexes(ctx) {
  await Promise.all([
    ctx.users.createIndex({ email: 1 }, { unique: true }),
    ctx.hackathons.createIndex({ slug: 1 }, { unique: true }),

    // Board: equality on (hackathonId, isOpen), then walk _id descending. No sort stage, no skip.
    ctx.teams.createIndex({ hackathonId: 1, isOpen: 1, _id: -1 }),
    // Board filtered by a wanted skill (multikey on lookingFor).
    ctx.teams.createIndex({ hackathonId: 1, isOpen: 1, lookingFor: 1, _id: -1 }),
    ctx.teams.createIndex({ inviteCodeHash: 1 }, { unique: true }),

    // THE invariant: one team per person per hackathon, enforced by the database.
    ctx.memberships.createIndex({ hackathonId: 1, userId: 1 }, { unique: true }),
    ctx.memberships.createIndex({ teamId: 1, joinedAt: 1, _id: 1 }),

    // At most one pending request per (team, user).
    ctx.joinRequests.createIndex(
      { teamId: 1, userId: 1 },
      { unique: true, partialFilterExpression: { status: 'pending' } },
    ),
    ctx.joinRequests.createIndex({ teamId: 1, status: 1, _id: 1 }),
    ctx.joinRequests.createIndex({ hackathonId: 1, userId: 1, status: 1 }),

    ctx.auditLog.createIndex({ teamId: 1, _id: -1 }),
    ctx.idempotencyKeys.createIndex({ createdAt: 1 }, { expireAfterSeconds: ctx.config.IDEMPOTENCY_TTL_HOURS * 3600 }),
  ]);
}

// One hackathon, defined by env. Team size limits are copied onto each team at creation,
// so changing the env later never shrinks an existing team below its member count.
async function ensureHackathon(ctx) {
  const { HACKATHON_SLUG: slug, HACKATHON_NAME: name, MIN_TEAM_SIZE, MAX_TEAM_SIZE } = ctx.config;
  return ctx.hackathons.findOneAndUpdate(
    { slug },
    { $set: { name, minTeamSize: MIN_TEAM_SIZE, maxTeamSize: MAX_TEAM_SIZE }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
}

const hasLabel = (err, label) => typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel(label);

/**
 * Runs fn(session) in a transaction with bounded retries.
 *
 * MongoDB does not queue conflicting writers: the second transaction to touch a document fails
 * immediately with a WriteConflict (labelled TransientTransactionError). We retry the whole
 * function with jittered backoff; on the retry it reads the winner's committed state and takes
 * the normal "team is full" path. Anything else (AppError, duplicate key) aborts and propagates.
 */
export async function withTxn(ctx, fn) {
  const max = ctx.config.TXN_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    const session = ctx.client.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      const result = await fn(session);
      await storeIdempotentResponse(ctx, session, result);
      await commit(session, max);
      return result;
    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction().catch((abortErr) => ctx.log.warn({ err: abortErr }, 'abortTransaction failed'));
      }
      if (!hasLabel(err, 'TransientTransactionError')) throw err;
      if (attempt >= max) {
        ctx.metrics.inc('txn_failures_total');
        throw new AppError(503, 'busy', 'The server is busy, please retry.', { cause: err, headers: { 'Retry-After': '1' } });
      }
      ctx.metrics.inc('txn_retries_total');
      await sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
    } finally {
      await session.endSession();
    }
  }
}

/**
 * A request that carries an Idempotency-Key gets its response stored in THIS transaction, next to the change it
 * describes: both commit or neither does. Without this, a crash between "commit" and "store the response" would
 * leave a committed change with no stored answer, and the client's retry would see a confusing 409 for something
 * that in fact succeeded. With it, the retry always replays the original success.
 */
async function storeIdempotentResponse(ctx, session, outcome) {
  const store = requestContext.getStore();
  if (!store?.idempotencyId || !store.status) return;
  await ctx.idempotencyKeys.updateOne(
    { _id: store.idempotencyId },
    { $set: { state: 'done', status: store.status, body: JSON.parse(JSON.stringify(outcome.result)) } },
    { session },
  );
}

// An unknown commit result must retry the commit itself, never the whole function:
// the first commit may have succeeded.
async function commit(session, max) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await session.commitTransaction();
    } catch (err) {
      if (!hasLabel(err, 'UnknownTransactionCommitResult') || attempt >= max) throw err;
    }
  }
}

export const isDuplicateKey = (err) => err?.code === 11000;
