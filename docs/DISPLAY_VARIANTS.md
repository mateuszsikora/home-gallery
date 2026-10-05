# Fullscreen display variants

## Policy and compatibility

A normalized, oriented, full-resolution WebP remains the source of truth. The v1 display recipe makes WebP images at quality 80, effort 4, with longest edges of 1280, 1920, and 2560 pixels. It preserves aspect ratio and orientation, uses the normalizer's input-pixel limit, and skips bounds equal to or above the source's longest edge. There are at most three display files per photo, with no arbitrary request dimensions or changes to administration thumbnails.

Each derivative is encoded in the existing temporary directory, synced, and atomically renamed into `media/`. A single display worker snapshots existing records on startup and accepts successful new uploads on the same queue. The queue is deduplicated by media ID and bounded by the stored library; only one display encode runs at once. Failed photos are retried on the next restart, with no busy retry loop. Ten consecutive failed records suspend the worker until restart. Shutdown cancels pending work and waits at most two seconds for the active operation; an encode that finishes later discards its result without reading the closed database. The existing administration-thumbnail worker is independent.

The public playlist advertises only committed, readable variants, through optional `variants` metadata; shared schemas and the typed API client accept both old and new playlists. Full-size URLs and dimensions keep their original meaning. Missing variants leave old libraries fully usable during backfill. A variant disappearing after a playlist poll is served as full-size bytes with `no-store`, while a decode error or preparation timeout makes the gallery prepare the item's full-size URL. The gallery remembers failed variant URLs only while their items remain in the playlist. A browser reload retries them.

Variant URLs include the recipe version and size, and their immutable ETags differ from full-size ETags. Every request checks the parent record and visibility before opening files or returning `304`. As with existing public full-size content, hiding a photo cannot retract bytes already cached by a client. The next playlist poll removes it from playback. Deleting the parent removes every possible display size; generation checks for concurrent deletion around publication.

## Gallery selection

For contain and blurred layouts, the rendered foreground scale is `min(viewportWidth / imageWidth, viewportHeight / imageHeight)`. Cover uses `max(...)` so cropped portraits or landscape images still have enough pixels. Multiplying by the device pixel ratio gives the required dimensions, rounded consistently with the encoder. The gallery picks the smallest adequate available variant, otherwise the full-size source. Blurred backgrounds deliberately reuse the foreground source: the existing quarter-size blurred layer does not justify a second, higher-resolution fetch.

Resize, orientation changes, pixel-density media-query changes, and fit updates recalculate selection. Changes that select the same URL leave preparation and display timing untouched. A changed source is prepared on new mounted elements while the current image remains visible; those prepared elements are then promoted unchanged. Foreground and backdrop use the same selected URL. No `srcset` decision can silently choose different bytes between preparation and display.

## Repeatable validation

Run `npm run check`, then:

```sh
npm run test:gallery:browser
node scripts/gallery-variants-benchmark.mjs /path/to/a/large/photo.jpg
```

The benchmark uses the real Fastify content/playlist routes, the Vite gallery, and headless Chromium. It creates a disposable library, generates 6000×4000 and 4000×6000 crops from the supplied photograph, and compares identical 1280×800 DPR 1 playback with and without variant metadata. Five fresh browser contexts per case disable caching; the script asserts one image resource request per displayed photo and records dimensions, encoded and transferred bytes, and the slower of the foreground/backdrop `decode()` readiness durations. Artifacts and screenshots go to `.context/variant-validation/`; input media and runtime data are not committed.

The decode interval includes image fetch and decode from the time preparation calls `decode()`. It is not an isolated codec benchmark. The RGBA estimate is width × height × 4 for one decoded image; it is not a measurement of process memory, GPU textures, duplicate layers, or actual browser retention. Loopback desktop results do not establish tablet responsiveness, long-term reliability, or the cause of any earlier playback interruptions.

## Recorded comparison — 2026-10-05

Environment: Apple M2 Pro, macOS/Darwin 25.5.0, Node 26.9.0, Sharp 0.35.4, headless Chromium 153.0.8010.12. Viewport 1280×800, DPR 1, `imageFit: auto`; landscape resolves to cover and portrait to blurred. Input: [Fronalpstock_big.jpg on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Fronalpstock_big.jpg), converted to the two crops described above. The portrait is a crop/rescale of the same landscape photograph, not an independent native portrait capture. Both baselines use the same normalized WebP bytes as their corresponding variant runs.

| Photo / source     | Selected dimensions | Encoded body bytes | Transferred bytes¹ | Decode readiness median (range), ms | Estimated RGBA MiB² |
| ------------------ | ------------------- | -----------------: | -----------------: | ----------------------------------- | ------------------: |
| Landscape, full    | 6000×4000           |          2,152,490 |          2,152,790 | 199.4 (178.9–222.2)                 |               91.55 |
| Landscape, variant | 1280×853            |            149,822 |            150,122 | 15.6 (13.6–16.5)                    |                4.17 |
| Portrait, full     | 4000×6000           |          1,679,636 |          1,679,936 | 161.7 (159.6–172.6)                 |               91.55 |
| Portrait, variant  | 853×1280            |            147,442 |            147,742 | 16.1 (15.6–17.7)                    |                4.17 |

¹ Resource Timing `transferSize`, including the browser's reported HTTP overhead; no network throttling. Every trial recorded exactly one image resource request, shared by preparation and the two displayed layers.

² The theoretical single-image RGBA footprint, not measured browser/process memory. Five trials per row are a local comparison, not a statistically controlled hardware performance claim.

Validation passed: `npm run check`, `npm run test:gallery:browser`, and `node scripts/gallery-variants-benchmark.mjs .context/variant-validation/source.jpg`. The browser smoke test also retained the existing maximum of four slide containers/eight image elements, with no preparation/promotion violations in normal or reduced-motion mode.
