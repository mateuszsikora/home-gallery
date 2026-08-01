import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { shutdownApp } from '../src/shutdown.js';
import {
  createTemporaryDataDirectory,
  createTestConfig,
  removeTemporaryDataDirectory,
} from './helpers.js';

describe('server shutdown', () => {
  let dataDirectory: string;

  beforeEach(async () => {
    dataDirectory = await createTemporaryDataDirectory();
  });

  afterEach(async () => {
    await removeTemporaryDataDirectory(dataDirectory);
  });

  it('closes Fastify and the database cleanly after SIGTERM', async () => {
    const app = await createApp(createTestConfig(dataDirectory));

    await expect(shutdownApp(app, 'SIGTERM', 1_000)).resolves.toBe(0);

    expect(app.database.open).toBe(false);
  });
});
