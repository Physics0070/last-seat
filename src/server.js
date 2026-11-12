import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';
import { connectDb } from './db.js';

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

async function shutdown(signal) {
  log.info({ signal }, 'shutting down');
  bus.close();
  server.close();
  server.closeIdleConnections();
  await ctx.client.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
