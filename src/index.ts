import { serve } from '@hono/node-server';

import { app } from './app';
import { assertSecureConfig, config } from './config';
import { queue } from './queue/runtime';
import { PushWorker } from './queue/worker';
import { createExpoTransport } from './services/expo-push';
import { db } from './db/client';

assertSecureConfig();

const worker = new PushWorker(queue, createExpoTransport(config.expoAccessToken), config.pushRate, config.pushMaxAttempts);
worker.start();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[Civitas Access] escuchando en http://localhost:${info.port}`);
  console.log(`[Civitas Access] panel web en http://localhost:${info.port}/login`);
  console.log(`[Civitas Access] base de datos: ${config.databasePath}`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 55_000);
  deadline.unref();
  await Promise.all([
    worker.stop(),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  db.close();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
