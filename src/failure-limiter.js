import { AppError } from './http.js';

/**
 * A rate limiter that spends its budget on WRONG GUESSES, not on requests.
 *
 * Brute-forcing an invite code means trying codes that do not exist. A valid code answered with "team is full" is
 * not a guess, and counting it would punish exactly the crowd the product exists for: fifty people on one office or
 * venue connection pressing "join" on the same team would be throttled after thirty. Here a key (an address, a user)
 * may make as many requests as it likes until `max` of them have been wrong; after that it is refused until the
 * window ends. A separate, general per-address limit still caps raw request volume.
 *
 * ponytail: counters live in process memory (one instance). Scale-out path: a shared store such as Redis.
 */
export function failureLimiter({ windowMs, max, key, isFailure }) {
  const entries = new Map(); // key -> { failures, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of entries) if (entry.resetAt <= now) entries.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = entries.get(k);
    if (entry && entry.resetAt <= now) {
      entries.delete(k);
      entry = undefined;
    }
    if (entry && entry.failures >= max) {
      return next(
        new AppError(429, 'rate_limited', 'Too many wrong invite codes. Try again later.', {
          headers: { 'Retry-After': String(Math.ceil((entry.resetAt - now) / 1000)) },
        }),
      );
    }
    res.on('finish', () => {
      if (!isFailure(res)) return;
      const current = entries.get(k) ?? { failures: 0, resetAt: Date.now() + windowMs };
      current.failures++;
      entries.set(k, current);
    });
    return next();
  };
}
