import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request state that the transaction helper needs but the domain functions should not have to pass around.
 * The idempotency middleware stores `{ idempotencyId, status }` here; `withTxn` then writes the stored response
 * inside the same transaction as the change itself.
 */
export const requestContext = new AsyncLocalStorage();
