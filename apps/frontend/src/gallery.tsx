import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import type { HomeGalleryClient } from '@home-gallery/api-client';
import type {
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

export interface GalleryProps {
  readonly apiBaseUrl: string;
  readonly client: PlaylistClient;
  readonly preloadImage?: (url: string) => void;
  readonly random?: () => number;
  readonly refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

const defaultPreloadImage = (url: string): void => {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
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

const itemById = (
  playlist: PlaylistResponse,
  id: string | undefined,
): PlaylistItem | undefined => playlist.items.find((item) => item.id === id);

const imageElement = (
  item: PlaylistItem,
  apiBaseUrl: string,
  state: 'current' | 'previous',
): ReactElement => (
  <img
    alt=""
    className={`gallery__image gallery__image--${state}`}
    data-state={state}
    decoding="async"
    height={item.height}
    key={item.id}
    src={resolveContentUrl(item.contentUrl, apiBaseUrl)}
    width={item.width}
  />
);

export const Gallery = ({
  apiBaseUrl,
  client,
  preloadImage = defaultPreloadImage,
  random = Math.random,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
}: GalleryProps): ReactElement => {
  const [playlist, setPlaylist] = useState<PlaylistResponse>();
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [previousId, setPreviousId] = useState<string>();
  const [playback, setPlayback] = useState<PlaybackState>({
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

  useEffect(() => {
    if (playback.currentId === undefined || playback.order.length < 2) {
      return;
    }

    const slideTimer = window.setTimeout(() => {
      setPlayback((current) => {
        if (current.currentId === undefined || current.order.length < 2) {
          return current;
        }

        const currentIndex = current.order.indexOf(current.currentId);
        const nextIndex = (currentIndex + 1) % current.order.length;
        const nextId = current.order[nextIndex];

        if (nextId === undefined) {
          return current;
        }

        setPreviousId(current.currentId);
        return { ...current, currentId: nextId };
      });
    }, playlist?.settings.slideDurationMs ?? 0);

    return () => {
      window.clearTimeout(slideTimer);
    };
  }, [playback.currentId, playback.order, playlist?.settings.slideDurationMs]);

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
    const preloadCount = Math.min(2, playback.order.length - 1);
    const urls = new Set<string>();

    for (let offset = 1; offset <= preloadCount; offset += 1) {
      const id =
        playback.order[(currentIndex + offset) % playback.order.length];
      const item = itemById(playlist, id);

      if (item !== undefined) {
        urls.add(resolveContentUrl(item.contentUrl, apiBaseUrl));
      }
    }

    for (const url of urls) {
      preloadImage(url);
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

  return (
    <main aria-label="Photo gallery" className="gallery" style={galleryStyle}>
      {currentItem === undefined ? (
        <p aria-live="polite" className="gallery__status" role="status">
          Preparing gallery…
        </p>
      ) : (
        imageElement(currentItem, apiBaseUrl, 'current')
      )}
      {previousItem === undefined
        ? null
        : imageElement(previousItem, apiBaseUrl, 'previous')}
      {connectionFailed ? (
        <p aria-live="polite" className="gallery__status" role="status">
          Connection lost. Continuing with the last playlist.
        </p>
      ) : null}
    </main>
  );
};
