# Gallery image preparation validation

Issue [#71](https://github.com/mateuszsikora/home-gallery/issues/71) changes preparation ownership: React mounts the incoming slide before decoding, and the same foreground and backdrop elements remain mounted when it becomes current. Playback still uses the failure, timeout, and retry policy from #70.

The buffer contains at most two upcoming slides, one current slide, and one fading slide, independently of playlist size. Each slide owns two image elements. Both layers are prepared even in contain/cover mode; the backdrop stays hidden until needed. This bounded extra layer lets viewport and fit changes reveal an already prepared backdrop without replacing elements or invalidating foreground readiness. Obsolete slides remove their sources and preparation listeners on cleanup. Each attempt gets a distinct React key, including retries and repeated visits to the same photo. Retained containers stay in mounting order during promotion; visibility and stacking come from state classes. Moving the outgoing container in the DOM can cancel its opacity transition even when its React key is unchanged.

The optional `preloadImage` integration hook receives `(url, signal, { image, backdrop })`. Implementations must prepare those actual elements and honor cancellation. The default implementation awaits both elements' `decode()` promises, rejects failures and mismatched selected sources, and supports load/error events when `decode()` is unavailable. Successful preparation describes these elements and this source at that time; it does not guarantee that a browser retains decoded pixels indefinitely.

## Reproduce

With Node.js 26 and dependencies installed:

```bash
npx vitest run apps/frontend/test/gallery.test.tsx
npx playwright install chromium
npm run test:gallery:browser
npm run check
```

The browser command starts an isolated Vite server on a loopback ephemeral port and exercises the real gallery entry point. Its only entry-point adjustment shortens playlist polling to 200 ms. Playwright supplies distinctly colored synthetic 1200 × 800 WebP images and playlist responses, withholds the incoming image response past the one-second slide deadline, and observes native decoding without replacing its result. No running API or real photo library is required. Browser installation is separate from `npm run check`.

## Recorded results — 2026-10-05

- Node.js **26.9.0**, macOS arm64, Playwright **1.63.0**, headless Chromium **153.0.8010.12**.
- **51 gallery component tests passed**, including foreground/backdrop identity, separate backdrop failure/readiness, stale source and reorder completions, timeout recovery, callback cancellation, StrictMode replay, stable DOM order across handoffs, layout changes, repeated cycles, and bounds with 4- and 100-item playlists.
- **`npm run check` passed: 452 tests**, formatting, lint, typechecking, and production builds. The review correction was checked in a clean copy of tracked files because a local `.context` review probe is included by ESLint in the working directory; review artifacts were preserved.
- **Browser validation passed twice**, with normal motion and `prefers-reduced-motion: reduce`. Each run observed 12 displayed slides, zero preparation/identity violations, at most 4 mounted slides and 8 image elements, and no page errors.
- The old photo remained the current opaque element after its deadline while the incoming response was blocked. Only the already decoded incoming foreground/backdrop became current. The outgoing element lost its source and left the document after the fade.
- The browser run also exercised contain/blur/cover layouts, a landscape-to-portrait resize while waiting, playlist removal/reordering, repeated cycles, source replacement, and an empty playlist. Animation-frame sampling verified intermediate outgoing opacity during every normal-motion handoff, including the delayed response and repeated cycles. Every reduced-motion sample had zero outgoing opacity. The configured durations remained 300 ms and 0 ms, respectively.

The fade regression reported in PR review was reproduced before the correction: the new DOM-order test failed, and browser samples showed only zero outgoing opacity despite a configured 300 ms transition. Keeping containers in stable mounting order made both regression checks pass. Checking `transitionDuration` alone was insufficient to detect the original failure.

## Limits

This is a desktop Chromium lifecycle test using a synthetic image and controlled HTTP responses. It does not measure decoded-memory retention, garbage collection, GPU pressure, pixel presentation timing, or long-running behavior with large camera images. Component tests use jsdom and cannot establish those properties either.

Android System WebView **138.0.7204.179** and a comparable constrained physical device were unavailable. Validation on the reported tablet, representative photos, and sustained memory pressure remains device follow-up. This change is not evidence of a memory leak or a confirmed fix for the earlier black-screen incident; the reported Glance host changes may have resolved that separate interruption.
