import { ConfigurationError, loadServerConfig } from '@home-gallery/config';
import type { FastifyInstance } from 'fastify';

import { createApp } from './app.js';

/** Time allowed for in-flight requests before the process is forced down. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const registerShutdownHandlers = (app: FastifyInstance): void => {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');

    const timeout = setTimeout(() => {
      app.log.error('Shutdown timed out, exiting immediately');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    app.close().then(
      () => {
        clearTimeout(timeout);
        process.exit(0);
      },
      (error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      },
    );
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
