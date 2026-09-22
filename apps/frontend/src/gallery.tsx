import {
  useEffect,
  useMemo,
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

/**
 * Fetches a photo ahead of its turn. The returned promise settles once the
 * photo is decoded and can be painted in the frame it is attached to the page,
 * which is what lets the slideshow hold a slide instead of cutting to an empty
 * frame.
 */
export type PreloadImage = (url: string) => Promise<void> | void;

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

/**
 * How long a slide may overstay its turn while the next photo is still being
 * fetched. Lingering on a photo reads as a slower slideshow; cutting to an
 * empty frame reads as a fault, so waiting is the calmer failure. The cap keeps
 * a photo that never arrives from stopping the slideshow altogether.
 */
const MAX_HOLD_FOR_NEXT_MS = 5_000;

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

const defaultPreloadImage: PreloadImage = async (url) => {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;

  // `decode` is missing outside a browser, where nothing loads anyway and the
  // photo is reported ready straight away.
  if (typeof image.decode !== 'function') {
    return;
  }

  try {
    await image.decode();
  } catch {
    // A file the browser cannot decode is treated as ready: it will not decode
    // on a later attempt either, so one broken photo must not stall playback.
  }
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

const itemById = (
  playlist: PlaylistResponse,
  id: string | undefined,
): PlaylistItem | undefined => playlist.items.find((item) => item.id === id);

const slideElement = (
  item: PlaylistItem,
  apiBaseUrl: string,
  state: 'current' | 'previous',
  layout: SlideLayout,
): ReactElement => {
  const source = resolveContentUrl(item.contentUrl, apiBaseUrl);

  return (
    <div className={`gallery__slide gallery__slide--${state}`} key={item.id}>
      {layout === 'blurred' ? (
        <img alt="" aria-hidden className="gallery__backdrop" src={source} />
      ) : null}
      <img
        alt=""
        className={`gallery__image gallery__image--${layout}`}
        data-state={state}
        decoding="async"
        height={item.height}
        src={source}
        width={item.width}
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
  const [previousId, setPreviousId] = useState<string>();
  const [playback, setPlayback] = useState<PlaybackState>({
    currentId: undefined,
    mode: 'sequential',
    order: [],
  });
  const [readyIds, setReadyIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [advanceRequested, setAdvanceRequested] = useState(false);
  const requestedIds = useRef(new Set<string>());

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
          setPlaylist(nextPlaylist);
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

  useEffect(() => {
    if (playlist === undefined) {
      return;
    }

    setPlayback((previous) =>
      reconcilePlayback(
        previous,
        playlist.items,
        playlist.settings.playbackMode,
        random,
      ),
    );
  }, [playlist, random]);

  const nextId = useMemo(() => {
    const { currentId, order } = playback;

    if (currentId === undefined || order.length < 2) {
      return undefined;
    }

    const currentIndex = order.indexOf(currentId);

    return currentIndex < 0
      ? undefined
      : order[(currentIndex + 1) % order.length];
  }, [playback]);

  useEffect(() => {
    if (nextId === undefined) {
      return;
    }

    const slideTimer = window.setTimeout(() => {
      setAdvanceRequested(true);
    }, playlist?.settings.slideDurationMs ?? 0);

    return () => {
      window.clearTimeout(slideTimer);
    };
  }, [nextId, playlist?.settings.slideDurationMs]);

  /**
   * The swap waits for the next photo to be decoded. Without the wait the new
   * slide is attached while its image is still loading, so the old photo fades
   * away to an empty frame and the new one appears at full opacity the moment
   * it arrives — the hardest cut in the loop, and the most likely one right
   * after the last photo, where the upcoming photo has not been touched since
   * the slideshow started.
   */
  useEffect(() => {
    if (!advanceRequested || nextId === undefined) {
      return;
    }

    // `nextId` is derived from the same playback this effect is keyed to, so a
    // playlist change cancels the pending swap and schedules it again.
    const advance = (): void => {
      setPreviousId(playback.currentId);
      setPlayback((current) => ({ ...current, currentId: nextId }));
      setAdvanceRequested(false);
    };

    if (readyIds.has(nextId)) {
      advance();

      return;
    }

    const holdTimer = window.setTimeout(advance, MAX_HOLD_FOR_NEXT_MS);

    return () => {
      window.clearTimeout(holdTimer);
    };
  }, [advanceRequested, nextId, playback, readyIds]);

  useEffect(() => {
    if (previousId === undefined) {
      return;
    }

    const fadeTimer = window.setTimeout(() => {
      setPreviousId(undefined);
    }, playlist?.settings.fadeDurationMs ?? 0);

    return () => {
      window.clearTimeout(fadeTimer);
    };
  }, [playlist?.settings.fadeDurationMs, previousId]);

  useEffect(() => {
    if (
      playlist === undefined ||
      playback.currentId === undefined ||
      playback.order.length < 2
    ) {
      return;
    }

    const currentIndex = playback.order.indexOf(playback.currentId);
    const preloadCount = Math.min(PRELOAD_AHEAD, playback.order.length - 1);
    const upcoming: PlaylistItem[] = [];

    for (let offset = 1; offset <= preloadCount; offset += 1) {
      const id =
        playback.order[(currentIndex + offset) % playback.order.length];
      const item = itemById(playlist, id);

      if (item !== undefined) {
        upcoming.push(item);
      }
    }

    // Only the photos around the playhead stay marked. A photo the browser may
    // have dropped from its cache during a long loop is fetched again before
    // its turn instead of being trusted on a stale mark.
    const tracked = new Set([
      playback.currentId,
      ...upcoming.map(({ id }) => id),
    ]);

    for (const id of requestedIds.current) {
      if (!tracked.has(id)) {
        requestedIds.current.delete(id);
      }
    }

    setReadyIds((previous) => {
      const retained = [...previous].filter((id) => tracked.has(id));

      return retained.length === previous.size ? previous : new Set(retained);
    });

    for (const item of upcoming) {
      if (requestedIds.current.has(item.id)) {
        continue;
      }

      requestedIds.current.add(item.id);

      void (async () => {
        try {
          await preloadImage(resolveContentUrl(item.contentUrl, apiBaseUrl));
        } catch {
          // A failed fetch is left unmarked and unrequested so the next pass
          // retries it; the hold cap keeps the slideshow moving meanwhile.
          requestedIds.current.delete(item.id);

          return;
        }

        // The playhead may have moved past this photo while it loaded, in
        // which case its mark was already dropped and must not come back.
        if (!requestedIds.current.has(item.id)) {
          return;
        }

        setReadyIds((previous) =>
          previous.has(item.id) ? previous : new Set(previous).add(item.id),
        );
      })();
    }
  }, [apiBaseUrl, playback, playlist, preloadImage]);

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

  const currentItem = itemById(playlist, playback.currentId);
  const previousItem = itemById(playlist, previousId);
  const galleryStyle = {
    '--fade-duration': `${playlist.settings.fadeDurationMs}ms`,
  } as CSSProperties;
  const layoutFor = (item: PlaylistItem): SlideLayout =>
    resolveSlideLayout(playlist.settings.imageFit, item, viewportAspect);

  return (
    <main aria-label="Photo gallery" className="gallery" style={galleryStyle}>
      {currentItem === undefined ? (
        <p aria-live="polite" className="gallery__status" role="status">
          Preparing gallery…
        </p>
      ) : (
        slideElement(currentItem, apiBaseUrl, 'current', layoutFor(currentItem))
      )}
      {previousItem === undefined
        ? null
        : slideElement(
            previousItem,
            apiBaseUrl,
            'previous',
            layoutFor(previousItem),
          )}
      {connectionFailed ? (
        <p aria-live="polite" className="gallery__status" role="status">
          Connection lost. Continuing with the last playlist.
        </p>
      ) : null}
    </main>
  );
};
