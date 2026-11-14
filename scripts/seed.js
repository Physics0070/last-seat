// Inserts SEED_USERS users and SEED_TEAMS teams with consistent memberships (see src/seed.js).
// Idempotent: every seeded document carries `seed: true`; a re-run removes those and inserts again.
import { pino } from 'pino';
import { z } from 'zod';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { seedSchema, writeSeed } from '../src/seed.js';

loadEnvFile();
const config = loadConfig();
const seed = seedSchema
  .extend({ SEED_PASSWORD: z.string().min(8, 'set SEED_PASSWORD (min 8 characters) in .env') })
  .parse(process.env);

const ctx = await connectDb(config, pino({ level: config.LOG_LEVEL }));
try {
  console.log(JSON.stringify(await writeSeed(ctx, config, seed, seed.SEED_PASSWORD)));
} finally {
  await ctx.client.close();
}
