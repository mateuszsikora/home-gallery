/* global document, HTMLImageElement, performance, window */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import console from 'node:console';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';
import { loadServerConfig } from '@home-gallery/config';
import { createApp } from '../apps/server/dist/app.js';

// Run after npm run build. Supply a local photograph; no photo is committed.
const input = process.argv[2];
assert.ok(
  input,
  'Usage: node scripts/gallery-variants-benchmark.mjs /path/to/photo.jpg',
);
const output = resolve('.context/variant-validation');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'gallery-variants-benchmark-'));
const app = await createApp(
  loadServerConfig({
    HOME_GALLERY_DATA_DIR: directory,
    HOME_GALLERY_INGESTION_TOKEN: randomUUID(),
    HOME_GALLERY_LOG_LEVEL: 'silent',
  }),
);
await app.listen({ host: '127.0.0.1', port: 0 });
const root = fileURLToPath(new URL('../apps/frontend', import.meta.url));
const vite = await createServer({
  root,
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: {
      '/api': app.listeningOrigin,
      '/media': app.listeningOrigin,
    },
  },
});
await vite.listen();
const browser = await chromium.launch();
const results = [];
try {
  for (const [orientation, width, height] of [
    ['landscape', 6000, 4000],
    ['portrait', 4000, 6000],
  ]) {
    const id = randomUUID();
    const storedFilename = `${id}.webp`;
    await sharp(resolve(input))
      .rotate()
      .resize(width, height, { fit: 'cover' })
      .webp({ quality: 85, effort: 4 })
      .toFile(app.mediaStorage.resolveMediaPath(storedFilename));
    const record = app.mediaRepository.create({
      id,
      storedFilename,
      originalFilename: 'benchmark.jpg',
      mediaType: 'image',
      mimeType: 'image/webp',
      source: 'api',
      width,
      height,
    });
    app.displayVariantWorker.enqueue(record);
    await app.displayVariantWorker.finished;
    app.settingsRepository.update({ slideDurationMs: 60000, imageFit: 'auto' });
    for (const variants of [false, true]) {
      const trials = [];
      for (let trial = 0; trial < 5; trial++) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/api/playlist', async (route) => {
          const response = await route.fetch();
          const playlist = await response.json();
          if (!variants)
            for (const item of playlist.items) delete item.variants;
          await route.fulfill({ json: playlist });
        });
        await page.addInitScript(() => {
          window.decodeMeasurements = [];
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = function () {
            const start = performance.now();
            return decode.call(this).then(() => {
              window.decodeMeasurements.push({
                source: this.src,
                durationMs: performance.now() - start,
              });
            });
          };
        });
        await page.goto(vite.resolvedUrls.local[0]);
        await page.waitForSelector('img[data-state="current"]');
        const measurement = await page.evaluate(() => {
          const image = document.querySelector('img[data-state="current"]');
          const resources = performance
            .getEntriesByType('resource')
            .filter(({ name }) => name === image.src);
          return {
            source: new URL(image.src).pathname,
            width: image.naturalWidth,
            height: image.naturalHeight,
            layout: image.className,
            requests: resources.length,
            encodedBytes: resources.reduce(
              (total, resource) => total + resource.encodedBodySize,
              0,
            ),
            transferredBytes: resources.reduce(
              (total, resource) => total + resource.transferSize,
              0,
            ),
            decodeReadyMs: Math.max(
              ...window.decodeMeasurements
                .filter(({ source }) => source === image.src)
                .map(({ durationMs }) => durationMs),
            ),
            rgbaBytesPerImage: image.naturalWidth * image.naturalHeight * 4,
          };
        });
        assert.deepEqual(errors, []);
        assert.equal(
          measurement.requests,
          1,
          'Preparation and display should fetch one source',
        );
        if (variants) assert.match(measurement.source, /\/display\/v1\/1280$/u);
        if (trial === 0 && variants)
          await page.screenshot({ path: join(output, `${orientation}.png`) });
        trials.push(measurement);
        await context.close();
      }
      results.push({ orientation, variants, trials });
    }
    app.mediaRepository.update(id, { enabled: false });
  }
  const report = {
    environment: {
      os: `${platform()} ${release()}`,
      cpu: cpus()[0].model,
      node: process.version,
      sharp: sharp.versions.sharp,
      browser: browser.version(),
      viewport: '1280x800',
      deviceScaleFactor: 1,
      trials: 5,
      network:
        'loopback, unthrottled, fresh context and disabled cache per trial',
    },
    results,
  };
  await writeFile(
    join(output, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await vite.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
