import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { connectDb } from './db.js';
import { seedOnBoot } from './seed.js';

loadEnvFile();
const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });

const ctx = await connectDb(config, log);
const { app, bus } = await createApp(ctx);
// Express 5 passes listen errors (such as EADDRINUSE) to this callback instead of throwing.
const server = app.listen(config.PORT, (err) => {
  if (err) throw err;
  log.info({ port: server.address().port }, 'listening');
});
// Opt-in demo data for hosts without a shell (SEED_ON_BOOT=if-empty). It runs after listen so health checks pass,
// and a failure is logged, not fatal: the app works without demo data.
seedOnBoot(ctx, config, process.env, log).catch((err) => log.error({ err }, 'seed on boot failed'));

async function shutdown(signal) {
  log.info({ signal }, 'shutting down');
  bus.close();
  server.close();
  server.closeIdleConnections();
  await ctx.client.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
