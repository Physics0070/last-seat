import { createHmac } from 'node:crypto';
import { isDuplicateKey } from './db.js';
import { AppError } from './http.js';
import { requestContext } from './request-context.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_FORMAT = /^[\x21-\x7e]{1,128}$/;

/**
 * Idempotency-Key support for every mutating endpoint.
 *
 * The record's _id is `<userId>:<key>` (`anon:<key>` for signup and login, which have no user yet), so the unique _id index is the lock: of N concurrent
 * requests with the same key exactly one insert succeeds and runs the handler.
 *   - finished record, same request  -> replay the stored status and body (Idempotency-Replayed: true)
 *   - same key, different request    -> 422
 *   - still processing               -> 409 + Retry-After (the lock expires, so a crashed request cannot block the key forever)
 *
 * For team changes the successful response is written INSIDE the change's own transaction (see withTxn in db.js):
 * the change and its stored answer commit together, so even a crash right after the commit leaves a retry
 * that replays the original success. Failures and signup/login complete the record after the handler instead;
 * the domain's unique indexes remain the safety net underneath either way.
 */
export function idempotency(ctx, { onReplay } = {}) {
  const lockMs = ctx.config.IDEMPOTENCY_LOCK_SECONDS * 1000;
  const records = ctx.idempotencyKeys;

  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined || !MUTATING.has(req.method)) return next();
    if (!KEY_FORMAT.test(key)) {
      throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 1-128 printable ASCII characters.');
    }

    const _id = `${req.user ? req.user.id : 'anon'}:${key}`;
    // Keyed hash: login and signup bodies contain a password, so a plain hash stored in the database
    // would be something to brute-force. Without JWT_SECRET this fingerprint reveals nothing.
    const fingerprint = createHmac('sha256', ctx.config.JWT_SECRET)
      .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? null)}`)
      .digest('hex');
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + lockMs);

    try {
      await records.insertOne({ _id, fingerprint, state: 'processing', lockedUntil, createdAt: now });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await records.findOne({ _id });
      if (existing && existing.fingerprint !== fingerprint) {
        throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request.');
      }
      if (existing?.state === 'done') {
        ctx.metrics.inc('idempotent_replays_total');
        onReplay?.(res, existing);
        return res.set('Idempotency-Replayed', 'true').status(existing.status).json(existing.body);
      }
      // Still marked processing: take over only if the first attempt's lock has expired (it crashed).
      const takenOver = await records.findOneAndUpdate(
        { _id, state: 'processing', lockedUntil: { $lt: now } },
        { $set: { lockedUntil } },
      );
      if (!takenOver) {
        throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still in progress.', {
          headers: { 'Retry-After': '1' },
        });
      }
    }

    // Persist the outcome before the response leaves, so a client that retries after reading
    // the response always finds the stored copy. 5xx is not stored: the retry should run again.
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      const store = requestContext.getStore();
      // The transaction already stored this exact success next to the change; writing it again would only add latency.
      if (store?.storedInTransaction && res.statusCode === store.status) {
        sendJson(body);
        return res;
      }
      const stored =
        res.statusCode >= 500
          ? records.deleteOne({ _id })
          : records.updateOne({ _id }, { $set: { state: 'done', status: res.statusCode, body: JSON.parse(JSON.stringify(body)) } });
      stored
        .catch((err) => req.log.error({ err }, 'failed to store idempotent response'))
        .then(() => sendJson(body));
      return res;
    };
    // `status` is filled in by the route (mutate) once it knows what success looks like.
    requestContext.run({ idempotencyId: _id, status: null }, () => next());
  };
}
