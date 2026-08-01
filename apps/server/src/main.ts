import { ConfigurationError, loadServerConfig } from '@home-gallery/config';
import type { FastifyInstance } from 'fastify';

import { createApp } from './app.js';
import { shutdownApp } from './shutdown.js';

const registerShutdownHandlers = (app: FastifyInstance): void => {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    void shutdownApp(app, signal).then((exitCode) => process.exit(exitCode));
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

const start = async (): Promise<void> => {
  let app: FastifyInstance | undefined;

  try {
    const config = loadServerConfig();
    app = await createApp(config);

    registerShutdownHandlers(app);

    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
    } else {
      console.error(error);
    }

    // The database is already open when listening fails, so release it before
    // the process exits instead of leaving a stale WAL lock behind.
    await app?.close().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  const runningApp = app;

  process.on('unhandledRejection', (reason) => {
    runningApp.log.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    runningApp.log.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
};

await start();
