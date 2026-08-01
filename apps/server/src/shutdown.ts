import type { FastifyInstance } from 'fastify';

/** Time allowed for in-flight requests before the process is forced down. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

class ShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Shutdown timed out after ${timeoutMs} ms`);
    this.name = 'ShutdownTimeoutError';
  }
}

/**
 * Stops accepting connections, waits for in-flight requests, and closes the
 * database through Fastify's onClose hook. The returned code lets the process
 * entry point own the final exit while tests exercise the complete close path.
 */
export const shutdownApp = async (
  app: FastifyInstance,
  signal: NodeJS.Signals,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<0 | 1> => {
  app.log.info({ signal }, 'Shutting down');

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new ShutdownTimeoutError(timeoutMs));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
    return 0;
  } catch (error) {
    app.log.error({ err: error }, 'Shutdown failed');
    return 1;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};
