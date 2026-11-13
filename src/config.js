import { existsSync } from 'node:fs';
import { z } from 'zod';

const int = (min, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const weight = z.coerce.number().min(0).max(1);

// Every value is required: there are no in-code defaults, so a missing variable fails at startup
// instead of silently running with a number nobody chose. `.env.example` lists them all.
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: int(0, 65535),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    TRUST_PROXY: int(0, 10),

    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
    MONGODB_DB: z.string().min(1),
    TXN_MAX_ATTEMPTS: int(1, 50),

    JWT_SECRET: z.string().min(32),
    JWT_TTL_SECONDS: int(60),
    COOKIE_SECURE: bool,

    HACKATHON_SLUG: z.string().regex(/^[a-z0-9-]+$/),
    HACKATHON_NAME: z.string().min(1),
    MIN_TEAM_SIZE: int(1),
    MAX_TEAM_SIZE: int(1),

    INVITE_TTL_HOURS: int(1),
    // 16 bytes = 128 bits is the floor: guessing is hopeless even before the rate limits.
    INVITE_CODE_BYTES: int(16, 32),

    RATE_LIMIT_WINDOW_MS: int(1000),
    RATE_LIMIT_MAX: int(1),
    AUTH_RATE_LIMIT_MAX: int(1),
    REDEEM_RATE_LIMIT_WINDOW_MS: int(1000),
    REDEEM_RATE_LIMIT_IP_MAX: int(1),
    REDEEM_RATE_LIMIT_USER_MAX: int(1),

    IDEMPOTENCY_TTL_HOURS: int(1),
    IDEMPOTENCY_LOCK_SECONDS: int(1),
    // How long published events stay in the outbox for replay after a reconnect or a restart.
    EVENT_RETENTION_HOURS: int(1),

    SSE_HEARTBEAT_MS: int(1000),
    SSE_RETRY_MS: int(100),
    SSE_REPLAY_BUFFER: int(1),
    // Most events replayed from the outbox to one reconnecting client; further behind than that, it refetches instead.
    SSE_OUTBOX_REPLAY_MAX: int(1),

    BOARD_PAGE_SIZE_DEFAULT: int(1),
    BOARD_PAGE_SIZE_MAX: int(1),
    // 0 disables the board page cache.
    BOARD_CACHE_TTL_MS: int(0),
    BOARD_CACHE_MAX_ENTRIES: int(1),

    SUGGEST_SKILL_WEIGHT: weight,
    SUGGEST_TZ_WEIGHT: weight,
    SUGGEST_SKILL_TARGET: int(1),
    SUGGEST_WORKDAY_HOURS: int(1, 24),
    SUGGEST_LIMIT: int(1, 100),
    SUGGEST_TEAM_POOL: int(1, 1000),
  })
  .refine((c) => c.MIN_TEAM_SIZE <= c.MAX_TEAM_SIZE, { message: 'MIN_TEAM_SIZE must be <= MAX_TEAM_SIZE' })
  .refine((c) => c.BOARD_PAGE_SIZE_DEFAULT <= c.BOARD_PAGE_SIZE_MAX, {
    message: 'BOARD_PAGE_SIZE_DEFAULT must be <= BOARD_PAGE_SIZE_MAX',
  })
  .refine((c) => c.SUGGEST_SKILL_WEIGHT + c.SUGGEST_TZ_WEIGHT > 0, { message: 'suggestion weights must not both be 0' });

export function loadEnvFile(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return Object.freeze(parsed.data);
}
