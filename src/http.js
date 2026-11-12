import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { z } from 'zod';

export class AppError extends Error {
  constructor(status, code, message, { details, cause, headers } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const objectId = z
  .string()
  .regex(/^[0-9a-f]{24}$/i, 'must be a 24-character hex id')
  .transform((v) => new ObjectId(v));

/** Validates one part of the request with a strict zod schema; unknown fields are rejected. */
export function parse(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new AppError(400, 'validation_error', 'Request validation failed.', {
    details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

export const SESSION_COOKIE = 'session';

export function signSession(config, userId) {
  return jwt.sign({ sub: String(userId) }, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: config.JWT_TTL_SECONDS });
}

export function cookieOptions(config) {
  // SameSite=Lax: the browser does not attach the cookie to cross-site POST/DELETE, which is the CSRF defence.
  return { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/', maxAge: config.JWT_TTL_SECONDS * 1000 };
}

function readUser(config, req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { sub } = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    return { id: new ObjectId(sub) };
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return null;
    throw err;
  }
}

export const requireAuth = (config) => (req, _res, next) => {
  req.user = readUser(config, req);
  next(req.user ? undefined : new AppError(401, 'unauthenticated', 'Sign in to continue.'));
};

export function notFound(req, _res, next) {
  next(new AppError(404, 'not_found', `No route for ${req.method} ${req.path}.`));
}

// One error shape for every failure: { error: { code, message, details? }, requestId }. No stack traces.
// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by its four arguments.
export function errorHandler(err, req, res, _next) {
  let error = err;
  if (!(error instanceof AppError)) {
    if (err?.type === 'entity.parse.failed') error = new AppError(400, 'invalid_json', 'Request body is not valid JSON.');
    else if (err?.type === 'entity.too.large') error = new AppError(413, 'payload_too_large', 'Request body is too large.');
    else {
      req.log.error({ err }, 'unhandled error');
      error = new AppError(500, 'internal_error', 'Something went wrong on our side.');
    }
  }
  if (error.headers) res.set(error.headers);
  res.status(error.status).json({
    error: { code: error.code, message: error.message, ...(error.details && { details: error.details }) },
    requestId: req.id,
  });
}
