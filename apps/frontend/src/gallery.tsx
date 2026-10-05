import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import type { HomeGalleryClient } from '@home-gallery/api-client';
import type {
  ImageFit,
  PlaybackMode,
  PlaylistItem,
  PlaylistResponse,
} from '@home-gallery/shared-types';

export type PlaylistClient = Pick<HomeGalleryClient, 'getPlaylist'>;

export interface PlaybackState {
  readonly currentId: string | undefined;
  readonly mode: PlaybackMode;
  readonly order: readonly string[];
}

/** Elements owned by React and retained from preparation through display. */
export interface SlideImages {
  readonly image: HTMLImageElement;
  readonly backdrop: HTMLImageElement;
}

/**
 * Prepare the supplied elements for this source. Readiness applies to these
 * elements, not to indefinite retention of decoded data by the browser.
 * Implementations must release pending work when the signal aborts.
 */
export type PreloadImage = (
  url: string,
  signal: AbortSignal,
  images: SlideImages,
) => Promise<void> | void;

export interface GalleryProps {
  readonly apiBaseUrl: string;
  readonly client: PlaylistClient;
  readonly preloadImage?: PreloadImage;
  readonly random?: () => number;
  readonly refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

/** How many upcoming photos are fetched and decoded ahead of their turn. */
const PRELOAD_AHEAD = 2;

/** Bound each attempt and pause between unsuccessful passes through the playlist. */
const PRELOAD_TIMEOUT_MS = 5_000;
const MAX_PRELOAD_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

/**
 * How a slide is laid out: letterboxed, letterboxed over a blurred copy of
 * itself, or cropped to fill the screen.
 */
export type SlideLayout = 'contain' | 'blurred' | 'cover';

/** Below this the letterbox bars are too thin to be worth filling. */
const ASPECT_MATCH_TOLERANCE = 0.01;

/**
 * `auto` only crops while the crop hides at most this much of the photo, which
 * keeps a phone's 4:3 photo full-bleed on both a 16:10 and a 16:9 screen — the
 * common pairings, losing 0.17 and 0.25 of the frame — but never cuts a
 * portrait photo down to a landscape strip.
 */
const AUTO_COVER_LOSS_LIMIT = 0.3;

const prepareImage = (
  image: HTMLImageElement,
  source: string,
  signal: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
      signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else if (
        image.src !== source ||
        (image.currentSrc && image.currentSrc !== source)
      ) {
        reject(new Error('Image source changed during preparation'));
      } else resolve();
    };
    const loaded = (): void => finish();
    const failed = (): void => finish(new Error('Image preparation failed'));
    const abort = (): void => finish(new Error('Image preparation cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    image.addEventListener('error', failed);
    if (typeof image.decode === 'function') {
      void image.decode().then(loaded, failed);
    } else if (image.complete) {
      if (image.naturalWidth > 0) loaded();
      else failed();
    } else {
      // Older WebViews without decode still have to finish loading the image.
      image.addEventListener('load', loaded);
    }
  });

const defaultPreloadImage: PreloadImage = async (source, signal, images) => {
  // Prepare both layers even in contain/cover mode. A resize or fit change can
  // then reveal the same ready backdrop without replacing either image.
  await Promise.all([
    prepareImage(images.image, source, signal),
    prepareImage(images.backdrop, source, signal),
  ]);
};

const arraysEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const shuffle = (values: readonly string[], random: () => number): string[] => {
  const shuffled = [...values];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = Math.min(Math.max(random(), 0), 0.999_999_999_999);
    const target = Math.floor(sample * (index + 1));
    [shuffled[index], shuffled[target]] = [
      shuffled[target] as string,
      shuffled[index] as string,
    ];
  }

  return shuffled;
};

export const reconcilePlayback = (
  previous: PlaybackState,
  items: readonly PlaylistItem[],
  mode: PlaybackMode,
  random: () => number,
): PlaybackState => {
  const itemIds = items.map(({ id }) => id);
  let order: readonly string[];

  if (mode === 'sequential') {
    order = itemIds;
  } else if (previous.mode === 'shuffle') {
    const available = new Set(itemIds);
    const retained = previous.order.filter((id) => available.has(id));
    const retainedSet = new Set(retained);
    const added = itemIds.filter((id) => !retainedSet.has(id));
    order = [...retained, ...shuffle(added, random)];
  } else {
    order = shuffle(itemIds, random);
  }

  const currentId =
    previous.currentId !== undefined && itemIds.includes(previous.currentId)
      ? previous.currentId
      : order[0];

  if (
    previous.currentId === currentId &&
    previous.mode === mode &&
    arraysEqual(previous.order, order)
  ) {
    return previous;
  }

  return { currentId, mode, order };
};

export const resolveContentUrl = (
  contentUrl: string,
  apiBaseUrl: string,
): string => new URL(contentUrl, apiBaseUrl).toString();

/**
 * Fraction of the photo that a crop to fill the screen hides: `0` when the two
 * aspect ratios match and `0.25` when a quarter of the frame is cut away. The
 * measure is symmetric, so it covers both a photo wider than the screen and a
 * photo taller than it.
 */
export const coverCropLoss = (
  imageAspect: number,
  viewportAspect: number,
): number => {
  const overhang = Math.max(
    imageAspect / viewportAspect,
    viewportAspect / imageAspect,
  );

  return 1 - 1 / overhang;
};

/**
 * Stored dimensions are already EXIF-oriented by the server, so the client can
 * decide the layout without waiting for the image to load.
 */
export const resolveSlideLayout = (
  fit: ImageFit,
  item: Pick<PlaylistItem, 'height' | 'width'>,
  viewportAspect: number,
): SlideLayout => {
  const imageAspect = item.width / item.height;

  if (
    fit === 'contain' ||
    !Number.isFinite(imageAspect) ||
    !Number.isFinite(viewportAspect) ||
    imageAspect <= 0 ||
    viewportAspect <= 0
  ) {
    return 'contain';
  }

  const loss = coverCropLoss(imageAspect, viewportAspect);

  if (loss <= ASPECT_MATCH_TOLERANCE) {
    return 'contain';
  }

  return fit === 'auto' && loss <= AUTO_COVER_LOSS_LIMIT ? 'cover' : 'blurred';
};

const readViewportAspect = (): number => {
  const { innerHeight, innerWidth } = window;

  return innerHeight > 0 ? innerWidth / innerHeight : 1;
};

const useViewportAspect = (): number => {
  const [aspect, setAspect] = useState(readViewportAspect);

  useEffect(() => {
    const update = (): void => {
      setAspect(readViewportAspect());
    };

    update();
    window.addEventListener('resize', update);

    return () => {
      window.removeEventListener('resize', update);
    };
  }, []);

  return aspect;
};

interface LoadedSlide {
  readonly item: PlaylistItem;
  readonly source: string;
}

interface PreparedSlide extends LoadedSlide {
  readonly key: number;
  readonly prepare: (images: SlideImages) => () => void;
}

const Slide = ({
  slide,
  state,
  layout,
}: {
  readonly slide: PreparedSlide;
  readonly state: 'current' | 'previous' | 'prepared';
  readonly layout: SlideLayout;
}): ReactElement => {
  const image = useRef<HTMLImageElement>(null);
  const backdrop = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const images = { image: image.current!, backdrop: backdrop.current! };
    for (const element of Object.values(images)) {
      if (element.src !== slide.source) element.src = slide.source;
    }
    const cancel = slide.prepare(images);
    return () => {
      cancel();
      for (const element of Object.values(images))
        element.removeAttribute('src');
    };
  }, [slide]);

  return (
    <div
      aria-hidden={state === 'prepared' ? true : undefined}
      className={`gallery__slide gallery__slide--${state}`}
    >
      <img
        ref={backdrop}
        alt=""
        aria-hidden
        className="gallery__backdrop"
        hidden={layout !== 'blurred'}
        decoding="async"
        src={slide.source}
      />
      <img
        ref={image}
        alt=""
        className={`gallery__image gallery__image--${layout}`}
        data-state={state}
        decoding="async"
        height={slide.item.height}
        src={slide.source}
        width={slide.item.width}
      />
    </div>
  );
};

export const Gallery = ({
  apiBaseUrl,
  client,
  preloadImage = defaultPreloadImage,
  random = Math.random,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
}: GalleryProps): ReactElement => {
  const [playlist, setPlaylist] = useState<PlaylistResponse>();
  const [connectionFailed, setConnectionFailed] = useState(false);
  const viewportAspect = useViewportAspect();
  const [currentSlide, setCurrentSlide] = useState<PreparedSlide>();
  const [previousSlide, setPreviousSlide] = useState<PreparedSlide>();
  const displayed = useRef<PreparedSlide | undefined>(undefined);
  const [preparedSlides, setPreparedSlides] = useState<
    readonly PreparedSlide[]
  >([]);
  const nextSlideKey = useRef(0);
  const preloadTimeouts = useRef(new Map<string, number>());
  const slideTiming = useRef<
    | {
        deadline: number;
        durationMs: number;
      }
    | undefined
  >(undefined);
  const playback = useRef<PlaybackState>({
    currentId: undefined,
    mode: 'sequential',
    order: [],
  });

  useEffect(() => {
    let disposed = false;
    let requestInFlight = false;

    const refresh = async (): Promise<void> => {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const nextPlaylist = await client.getPlaylist();

        if (!disposed) {
          setPlaylist((previous) => ({
            ...nextPlaylist,
            // Identical polls must not restart playback or pending retries.
            items:
              previous !== undefined &&
              JSON.stringify(previous.items) ===
                JSON.stringify(nextPlaylist.items)
                ? previous.items
                : nextPlaylist.items,
          }));
          setConnectionFailed(false);
        }
      } catch {
        if (!disposed) {
          setConnectionFailed(true);
        }
      } finally {
        requestInFlight = false;
      }
    };

    void refresh();
    const refreshTimer = window.setInterval(() => {
      void refresh();
    }, refreshIntervalMs);

    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
    };
  }, [client, refreshIntervalMs]);

  const items = playlist?.items;
  const mode = playlist?.settings.playbackMode;
  const slideDurationMs = playlist?.settings.slideDurationMs;

  useEffect(() => {
    if (
      items === undefined ||
      mode === undefined ||
      slideDurationMs === undefined
    ) {
      return;
    }

    playback.current = reconcilePlayback(playback.current, items, mode, random);
    if (items.length === 0) {
      displayed.current = undefined;
      slideTiming.current = undefined;
      preloadTimeouts.current.clear();
      setCurrentSlide(undefined);
      setPreviousSlide(undefined);
      setPreparedSlides([]);
      return;
    }

    const startSlideDuration = (): void => {
      slideTiming.current = {
        deadline: performance.now() + slideDurationMs,
        durationMs: slideDurationMs,
      };
    };
    // Only a new photo or a changed duration starts a new display deadline.
    // Rebuilding candidate requests must not postpone an unchanged slide.
    if (
      displayed.current !== undefined &&
      slideTiming.current?.durationMs !== slideDurationMs
    ) {
      startSlideDuration();
    }

    const ordered = playback.current.order.map((id) => {
      const item = items.find((candidate) => candidate.id === id)!;
      return { item, source: resolveContentUrl(item.contentUrl, apiBaseUrl) };
    });
    const sources = new Set(ordered.map(({ source }) => source));
    for (const source of preloadTimeouts.current.keys()) {
      if (!sources.has(source)) preloadTimeouts.current.delete(source);
    }
    let disposed = false;
    let cancelDelay: (() => void) | undefined;
    const requests = new Map<
      LoadedSlide,
      {
        slide: PreparedSlide;
        failed: boolean;
        result: Promise<boolean>;
        cancel: () => void;
      }
    >();

    const delay = (durationMs: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = window.setTimeout(resolve, durationMs);
        cancelDelay = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });
    const waitForSlideDeadline = async (): Promise<void> => {
      const remainingMs =
        (slideTiming.current?.deadline ?? 0) - performance.now();
      if (remainingMs > 0) await delay(remainingMs);
    };
    const request = (slide: LoadedSlide): Promise<boolean> => {
      const existing = requests.get(slide);
      if (existing !== undefined) return existing.result;

      const controller = new AbortController();
      const timeoutMs =
        preloadTimeouts.current.get(slide.source) ?? PRELOAD_TIMEOUT_MS;
      let finish: (ready: boolean) => void = () => {};
      const result = new Promise<boolean>((resolve) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          // Grow only this source's next attempt: faster photos must not reset
          // a slow photo's progress, and obsolete cancellations are not failures.
          preloadTimeouts.current.set(
            slide.source,
            Math.min(timeoutMs * 2, MAX_PRELOAD_TIMEOUT_MS),
          );
          finish(false);
        }, timeoutMs);
        finish = (ready) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (ready) preloadTimeouts.current.delete(slide.source);
          else {
            controller.abort();
            const failed = requests.get(slide);
            if (failed !== undefined) failed.failed = true;
            setPreparedSlides((slides) =>
              slides.filter((candidate) => candidate !== failed?.slide),
            );
          }
          resolve(ready);
        };
      });
      const prepared: PreparedSlide = {
        ...slide,
        key: nextSlideKey.current++,
        prepare: (images) => {
          const mounted = new AbortController();
          const abort = (): void => mounted.abort();
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
          // Each effect lifetime owns its listeners, including StrictMode replay.
          void Promise.resolve()
            .then(() => {
              if (disposed || mounted.signal.aborted) return;
              return preloadImage(slide.source, mounted.signal, images);
            })
            .then(
              () => {
                if (!mounted.signal.aborted) finish(true);
              },
              () => {
                if (!mounted.signal.aborted) finish(false);
              },
            );
          return () => {
            controller.signal.removeEventListener('abort', abort);
            abort();
          };
        },
      };
      requests.set(slide, {
        slide: prepared,
        failed: false,
        result,
        cancel: () => finish(false),
      });
      return result;
    };
    const prepare = (candidates: readonly LoadedSlide[]): void => {
      const upcoming = candidates.slice(0, PRELOAD_AHEAD);
      for (const [slide, pending] of requests) {
        if (!upcoming.includes(slide)) {
          pending.cancel();
          requests.delete(slide);
        }
      }
      for (const slide of upcoming) void request(slide);
      setPreparedSlides(
        upcoming.flatMap((slide) => {
          const request = requests.get(slide)!;
          return request.failed ? [] : [request.slide];
        }),
      );
    };
    const candidatesAfterCurrent = (): LoadedSlide[] => {
      const currentIndex = ordered.findIndex(
        (slide) =>
          slide.item.id === displayed.current?.item.id &&
          slide.source === displayed.current.source,
      );
      return currentIndex < 0
        ? ordered
        : [
            ...ordered.slice(currentIndex + 1),
            ...ordered.slice(0, currentIndex),
          ];
    };

    const run = async (): Promise<void> => {
      let candidates = candidatesAfterCurrent();
      // A retained photo waits only for the remainder of its display time.
      // A removed/replaced photo stays visible only until a replacement is ready.
      if (candidates.length < ordered.length) {
        prepare(candidates);
        if (candidates.length === 0) return;
        await waitForSlideDeadline();
      }
      while (!disposed) {
        let advanced = false;
        for (
          let index = 0;
          index < candidates.length && !disposed;
          index += 1
        ) {
          prepare(candidates.slice(index));
          const candidate = candidates[index]!;
          const ready = await request(candidate);
          if (disposed) return;
          if (!ready) continue;

          setPreviousSlide(displayed.current);
          const prepared = requests.get(candidate)!.slide;
          displayed.current = prepared;
          startSlideDuration();
          setCurrentSlide(prepared);
          playback.current = {
            ...playback.current,
            currentId: candidate.item.id,
          };
          advanced = true;
          break;
        }
        if (disposed) return;
        if (advanced) {
          candidates = candidatesAfterCurrent();
          prepare(candidates);
          if (candidates.length === 0) return;
          await waitForSlideDeadline();
        } else {
          // Even synchronous failures get a full pause before another pass.
          // At most PRELOAD_AHEAD requests can be alive at any time.
          for (const pending of requests.values()) pending.cancel();
          requests.clear();
          setPreparedSlides([]);
          await delay(RETRY_DELAY_MS);
          candidates = candidatesAfterCurrent();
        }
      }
    };
    void run();

    return () => {
      disposed = true;
      cancelDelay?.();
      for (const pending of requests.values()) pending.cancel();
      requests.clear();
      setPreparedSlides([]);
    };
  }, [apiBaseUrl, items, mode, preloadImage, random, slideDurationMs]);

  useEffect(() => {
    if (previousSlide === undefined) return;
    const timer = window.setTimeout(() => {
      setPreviousSlide(undefined);
    }, playlist?.settings.fadeDurationMs ?? 0);
    return () => window.clearTimeout(timer);
  }, [playlist?.settings.fadeDurationMs, previousSlide]);

  if (playlist === undefined) {
    return (
      <main className="gallery gallery--message">
        <p aria-live="polite" role="status">
          {connectionFailed
            ? 'Gallery is temporarily unavailable. Retrying automatically.'
            : 'Loading gallery…'}
        </p>
      </main>
    );
  }

  if (playlist.items.length === 0) {
    return (
      <main className="gallery gallery--message">
        <p aria-live="polite" role="status">
          {connectionFailed
            ? 'Connection lost. Waiting for the gallery to return.'
            : 'No photos yet. New uploads will appear automatically.'}
        </p>
      </main>
    );
  }

  const galleryStyle = {
    '--fade-duration': `${playlist.settings.fadeDurationMs}ms`,
  } as CSSProperties;
  const layoutFor = (item: PlaylistItem): SlideLayout =>
    resolveSlideLayout(playlist.settings.imageFit, item, viewportAspect);

  return (
    <main aria-label="Photo gallery" className="gallery" style={galleryStyle}>
      {currentSlide === undefined ? (
        <p aria-live="polite" className="gallery__status" role="status">
          Waiting for photos to load. Retrying automatically.
        </p>
      ) : null}
      {[currentSlide, previousSlide, ...preparedSlides]
        .filter(
          (slide, index, slides): slide is PreparedSlide =>
            slide !== undefined && slides.indexOf(slide) === index,
        )
        // Moving a retained container during promotion can cancel its CSS fade.
        // State classes and z-index control visibility; mounting order stays fixed.
        .sort((left, right) => left.key - right.key)
        .map((slide) => (
          <Slide
            key={slide.key}
            slide={slide}
            state={
              slide === currentSlide
                ? 'current'
                : slide === previousSlide
                  ? 'previous'
                  : 'prepared'
            }
            layout={layoutFor(slide.item)}
          />
        ))}
      {connectionFailed ? (
        <p aria-live="polite" className="gallery__status" role="status">
          Connection lost. Continuing with the last playlist.
        </p>
      ) : null}
    </main>
  );
};
