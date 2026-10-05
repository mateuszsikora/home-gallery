/* global document, HTMLImageElement, MutationObserver, window, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../apps/frontend', import.meta.url));
const server = await createServer({
  root,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'gallery-validation-refresh',
      enforce: 'pre',
      transform(code, id) {
        // Exercise the real entry point with faster playlist polling only.
        if (id === `${root}/src/main.tsx`) {
          assert.ok(
            code.includes('<Gallery'),
            'Expected untransformed gallery entry point',
          );
          return code.replace('<Gallery', '<Gallery refreshIntervalMs={200}');
        }
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch();
const results = [];
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({
      viewport: { width: 960, height: 600 },
      reducedMotion,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ids = Array.from(
      { length: 12 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    let playlist = {
      items: ids.map((id) => ({
        id,
        contentUrl: `/media/${id}`,
        mimeType: 'image/webp',
        width: 1200,
        height: 800,
      })),
      settings: {
        slideDurationMs: 1000,
        fadeDurationMs: 300,
        playbackMode: 'sequential',
        imageFit: 'contain',
      },
    };
    const photos = await Promise.all(
      ['#476f9c', '#b45538', '#648448'].map((background) =>
        sharp({ create: { width: 1200, height: 800, channels: 3, background } })
          .webp()
          .toBuffer(),
      ),
    );
    let releaseSlow;
    const slowResponse = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    let delaySecond = true;
    await page.route('**/api/playlist', (route) =>
      route.fulfill({ json: playlist }),
    );
    await page.route('**/media/**', async (route) => {
      if (delaySecond && route.request().url().endsWith(ids[1]))
        await slowResponse;
      const index = ids.findIndex((id) => route.request().url().endsWith(id));
      await route.fulfill({
        contentType: 'image/webp',
        body: photos[Math.max(0, index) % photos.length],
      });
    });
    await page.addInitScript(() => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      const ready = new WeakSet();
      const prepared = new WeakSet();
      const shown = new WeakSet();
      window.validation = {
        transitions: [],
        fades: [],
        violations: [],
        maxSlides: 0,
        maxImages: 0,
      };
      HTMLImageElement.prototype.decode = function () {
        if (this.isConnected && this.closest('.gallery__slide--prepared'))
          prepared.add(this);
        return nativeDecode.call(this).then(() => ready.add(this));
      };
      new MutationObserver(() => {
        const report = window.validation;
        report.maxSlides = Math.max(
          report.maxSlides,
          document.querySelectorAll('.gallery__slide').length,
        );
        report.maxImages = Math.max(
          report.maxImages,
          document.querySelectorAll('.gallery img').length,
        );
        const current = document.querySelector('img[data-state="current"]');
        if (!current || shown.has(current)) return;
        shown.add(current);
        const backdrop =
          current.parentElement.querySelector('.gallery__backdrop');
        if (
          ![current, backdrop].every(
            (image) => prepared.has(image) && ready.has(image),
          )
        ) {
          report.violations.push(
            'Displayed an element that was not prepared and decoded while mounted',
          );
        }
        if (getComputedStyle(current.parentElement).opacity !== '1')
          report.violations.push('Replacement was not opaque');
        report.transitions.push(current.src);
        const outgoing = document.querySelector('.gallery__slide--previous');
        if (outgoing) {
          const fade = {
            source: outgoing.querySelector('.gallery__image').src,
            opacities: [],
          };
          report.fades.push(fade);
          const sample = () => {
            if (
              !outgoing.isConnected ||
              !outgoing.classList.contains('gallery__slide--previous')
            )
              return;
            fade.opacities.push(Number(getComputedStyle(outgoing).opacity));
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }
      }).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-state'],
      });
    });
    await page.goto(server.resolvedUrls.local[0], {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('img[data-state="current"]');
    await page.evaluate(() => {
      window.first = document.querySelector('img[data-state="current"]');
      window.incoming = document.querySelector('img[data-state="prepared"]');
      window.incomingBackdrop =
        window.incoming.parentElement.querySelector('.gallery__backdrop');
    });
    // The response stays blocked past the display deadline, below the 5s timeout.
    await page.waitForTimeout(1400);
    assert.equal(
      await page.evaluate(
        () =>
          window.first ===
            document.querySelector('img[data-state="current"]') &&
          getComputedStyle(window.first.parentElement).opacity === '1' &&
          !document.querySelector('.gallery__slide--previous'),
      ),
      true,
    );
    // A fit change and resize while waiting must preserve the prepared elements.
    playlist.settings.imageFit = 'blur';
    await page.setViewportSize({ width: 600, height: 960 });
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(
        () =>
          window.incoming.isConnected && window.incomingBackdrop.isConnected,
      ),
      true,
    );
    delaySecond = false;
    releaseSlow();
    await page.waitForFunction(
      () =>
        window.incoming === document.querySelector('img[data-state="current"]'),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.incoming.parentElement.querySelector('.gallery__backdrop') ===
          window.incomingBackdrop,
      ),
      true,
    );
    const previous = page.locator('.gallery__slide--previous');
    assert.equal(
      await previous.evaluate(
        (element) => getComputedStyle(element).transitionDuration,
      ),
      reducedMotion === 'reduce' ? '0s' : '0.3s',
    );
    await page.waitForTimeout(400);
    assert.equal(
      await page.evaluate(
        () => !window.first.isConnected && !window.first.hasAttribute('src'),
      ),
      true,
    );
    // Shorten and reorder the playlist, then exercise repeated loops.
    playlist.items = [playlist.items[1], playlist.items[3], playlist.items[0]];
    await page.waitForFunction(
      () => window.validation.transitions.length >= 11,
      null,
      { timeout: 15000 },
    );
    playlist.settings.imageFit = 'auto';
    await page.setViewportSize({ width: 960, height: 600 });
    await page.waitForSelector(
      '.gallery__slide--current .gallery__image--cover',
    );
    // Replace the current source, retaining the last good element until decode.
    const oldSource = await page
      .locator('img[data-state="current"]')
      .getAttribute('src');
    playlist.items = [
      {
        ...playlist.items.find((item) => oldSource.endsWith(item.id)),
        contentUrl: '/media/replacement.webp',
      },
    ];
    await page.waitForFunction(() =>
      document
        .querySelector('img[data-state="current"]')
        ?.src.endsWith('/replacement.webp'),
    );
    // Sample the entire final fade before checking all handoffs, including loops.
    await page.waitForSelector('.gallery__slide--previous', {
      state: 'detached',
    });
    const report = await page.evaluate(() => window.validation);
    assert.equal(report.fades.length, report.transitions.length - 1);
    for (const fade of report.fades) {
      assert.ok(
        fade.opacities.length > 0,
        `No animation-frame samples: ${fade.source}`,
      );
      if (reducedMotion === 'reduce') {
        assert.ok(
          fade.opacities.every((opacity) => opacity === 0),
          JSON.stringify(fade),
        );
      } else {
        assert.ok(
          fade.opacities.some((opacity) => opacity > 0 && opacity < 1),
          `Missing visible fade: ${JSON.stringify(fade)}`,
        );
      }
    }
    assert.deepEqual(report.violations, []);
    assert.ok(report.maxSlides <= 4, JSON.stringify(report));
    assert.ok(report.maxImages <= 8, JSON.stringify(report));
    assert.ok(report.transitions.length >= 12);
    await mkdir(new URL('../.context/', import.meta.url), { recursive: true });
    await page.screenshot({
      path: fileURLToPath(
        new URL(`../.context/gallery-${reducedMotion}.png`, import.meta.url),
      ),
    });
    playlist.items = [];
    await page.waitForSelector('.gallery--message');
    assert.equal(await page.locator('img').count(), 0);
    assert.deepEqual(errors, []);
    results.push({ reducedMotion, ...report });
    await context.close();
  }
  console.log(
    JSON.stringify(
      { browser: `Chromium ${browser.version()}`, results },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
