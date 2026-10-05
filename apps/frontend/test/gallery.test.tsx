// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { StrictMode } from 'react';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaylistResponse } from '@home-gallery/shared-types';

import {
  coverCropLoss,
  Gallery,
  resolveSlideLayout,
  type PlaylistClient,
} from '../src/gallery.js';

const ids = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
  fourth: '00000000-0000-4000-8000-000000000004',
} as const;

const mediaUrl = (id: string): string => `http://gallery.test/media/${id}`;

/**
 * A preloader whose promises only settle when the test says so, which is how
 * the slideshow behaves around a photo the browser has not finished decoding.
 */
const createPreloadTracker = (): {
  readonly callsFor: (url: string) => number;
  readonly preloadImage: (url: string) => Promise<void>;
  readonly resolveAll: () => void;
  readonly resolve: (url: string) => void;
} => {
  const calls: string[] = [];
  const pending = new Map<string, () => void>();

  return {
    callsFor: (url) => calls.filter((called) => called === url).length,
    preloadImage: async (url) => {
      calls.push(url);

      await new Promise<void>((resolve) => {
        pending.set(url, resolve);
      });
    },
    resolve: (url) => {
      pending.get(url)?.();
      pending.delete(url);
    },
    resolveAll: () => {
      for (const resolve of pending.values()) {
        resolve();
      }

      pending.clear();
    },
  };
};

interface ItemSize {
  readonly height: number;
  readonly width: number;
}

const LANDSCAPE: ItemSize = { height: 1_080, width: 1_920 };

const createPlaylist = (
  itemIds: readonly string[],
  overrides: Partial<PlaylistResponse['settings']> = {},
  size: ItemSize = LANDSCAPE,
): PlaylistResponse => ({
  items: itemIds.map((id) => ({
    id,
    contentUrl: `/media/${id}`,
    mimeType: 'image/webp',
    width: size.width,
    height: size.height,
  })),
  settings: {
    slideDurationMs: 4_000,
    fadeDurationMs: 800,
    playbackMode: 'sequential',
    imageFit: 'contain',
    ...overrides,
  },
});

const flushPromises = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const currentImage = (): HTMLImageElement => {
  const image = document.querySelector<HTMLImageElement>(
    'img[data-state="current"]',
  );

  if (image === null) {
    throw new Error('Current gallery image was not rendered');
  }

  return image;
};

// Playback assertions use semantic roles; DOM order stays fixed for animation.
const renderedImages = (): HTMLImageElement[] =>
  ['current', 'previous'].flatMap((state) => [
    ...document.querySelectorAll<HTMLImageElement>(
      `img[data-state="${state}"]`,
    ),
  ]);

const backdropImages = (): HTMLImageElement[] => [
  ...document.querySelectorAll<HTMLImageElement>(
    'img.gallery__backdrop:not([hidden])',
  ),
];

const resizeViewport = async (width: number, height: number): Promise<void> => {
  window.innerWidth = width;
  window.innerHeight = height;

  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
};

const DEFAULT_VIEWPORT = {
  height: window.innerHeight,
  width: window.innerWidth,
} as const;

beforeEach(() => {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.innerWidth = DEFAULT_VIEWPORT.width;
  window.innerHeight = DEFAULT_VIEWPORT.height;
});

describe('Gallery', () => {
  it('shows calm loading and empty states', async () => {
    const client: PlaylistClient = {
      getPlaylist: vi.fn().mockResolvedValue(createPlaylist([])),
    };

    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading gallery');
    expect(
      await screen.findByText(
        'No photos yet. New uploads will appear automatically.',
      ),
    ).toBeVisible();
  });

  it('recovers after an initial playlist failure', async () => {
    vi.useFakeTimers();
    const client: PlaylistClient = {
      getPlaylist: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(createPlaylist([ids.first])),
    };

    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        refreshIntervalMs={1_000}
      />,
    );
    await flushPromises();

    expect(screen.getByRole('status')).toHaveTextContent(
      'Gallery is temporarily unavailable',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.first}`,
    );
  });

  it('advances sequentially on the server timing and removes the faded image', async () => {
    vi.useFakeTimers();
    const client: PlaylistClient = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second], {
          slideDurationMs: 3_000,
          fadeDurationMs: 1_000,
        }),
      ),
    };

    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();

    const firstImage = currentImage();
    expect(firstImage).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.first}`,
    );
    expect(screen.getByLabelText('Photo gallery')).toHaveStyle(
      '--fade-duration: 1000ms',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.first}`,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    const imagesDuringFade = renderedImages();
    expect(imagesDuringFade).toHaveLength(2);
    expect(imagesDuringFade[0]).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.second}`,
    );
    expect(imagesDuringFade[1]).toHaveAttribute('data-state', 'previous');
    expect(imagesDuringFade[1]).toBe(firstImage);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(renderedImages()).toHaveLength(1);
  });

  it('keeps a one-item playlist stable', async () => {
    vi.useFakeTimers();
    const client: PlaylistClient = {
      getPlaylist: vi.fn().mockResolvedValue(createPlaylist([ids.first])),
    };

    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.first}`,
    );
    expect(renderedImages()).toHaveLength(1);
  });

  it('uses a shuffled playback order without mutating the server order', async () => {
    vi.useFakeTimers();
    const playlist = createPlaylist([ids.first, ids.second, ids.third], {
      playbackMode: 'shuffle',
      slideDurationMs: 1_000,
    });
    const client: PlaylistClient = {
      getPlaylist: vi.fn().mockResolvedValue(playlist),
    };

    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        random={() => 0}
      />,
    );
    await flushPromises();

    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.second}`,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.third}`,
    );
    expect(playlist.items.map(({ id }) => id)).toEqual([
      ids.first,
      ids.second,
      ids.third,
    ]);
  });

  it('keeps playing the last playlist through refresh failures and preserves the active item', async () => {
    vi.useFakeTimers();
    const firstPlaylist = createPlaylist([ids.first, ids.second], {
      slideDurationMs: 1_000,
    });
    const refreshedPlaylist = createPlaylist(
      [ids.first, ids.second, ids.third],
      { slideDurationMs: 1_000 },
    );
    const client: PlaylistClient = {
      getPlaylist: vi
        .fn()
        .mockResolvedValueOnce(firstPlaylist)
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(refreshedPlaylist),
    };

    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        refreshIntervalMs={500}
      />,
    );
    await flushPromises();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Continuing with the last playlist',
    );
    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.first}`,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(currentImage()).toHaveAttribute(
      'src',
      `http://gallery.test/media/${ids.second}`,
    );
  });

  it('preloads the next two images against the API base URL', async () => {
    const preloadImage = vi.fn();
    const client: PlaylistClient = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(createPlaylist([ids.first, ids.second, ids.third])),
    };

    render(
      <Gallery
        apiBaseUrl="http://api.test:3012/base"
        client={client}
        preloadImage={preloadImage}
      />,
    );

    await waitFor(() => {
      expect(preloadImage).toHaveBeenCalledWith(
        `http://api.test:3012/media/${ids.second}`,
        expect.any(AbortSignal),
        expect.objectContaining({
          image: expect.any(HTMLImageElement),
          backdrop: expect.any(HTMLImageElement),
        }),
      );
    });
    expect(preloadImage).toHaveBeenCalledWith(
      `http://api.test:3012/media/${ids.third}`,
      expect.any(AbortSignal),
      expect.objectContaining({
        image: expect.any(HTMLImageElement),
        backdrop: expect.any(HTMLImageElement),
      }),
    );
  });

  it('holds the current photo until the next one is decoded', async () => {
    vi.useFakeTimers();
    const preloads = createPreloadTracker();
    const client: PlaylistClient = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second], {
          slideDurationMs: 1_000,
          fadeDurationMs: 200,
        }),
      ),
    };

    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
      />,
    );
    await flushPromises();
    await act(async () => preloads.resolve(mediaUrl(ids.first)));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    expect(renderedImages()).toHaveLength(1);

    await act(async () => {
      preloads.resolveAll();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
    expect(renderedImages()[1]).toHaveAttribute('data-state', 'previous');
  });

  it('retains the last good photo when an upcoming photo never arrives', async () => {
    vi.useFakeTimers();
    const preloads = createPreloadTracker();
    const client: PlaylistClient = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(
          createPlaylist([ids.first, ids.second], { slideDurationMs: 1_000 }),
        ),
    };

    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
      />,
    );
    await flushPromises();
    await act(async () => preloads.resolve(mediaUrl(ids.first)));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    expect(renderedImages()).toHaveLength(1);
  });

  it('decodes a photo again once the loop comes back around to it', async () => {
    vi.useFakeTimers();
    const preloads = createPreloadTracker();
    const client: PlaylistClient = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second, ids.third, ids.fourth], {
          slideDurationMs: 1_000,
          fadeDurationMs: 200,
        }),
      ),
    };

    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
      />,
    );
    await flushPromises();
    await act(async () => preloads.resolve(mediaUrl(ids.first)));

    expect(preloads.callsFor(mediaUrl(ids.second))).toBe(1);

    for (let step = 0; step < 3; step += 1) {
      await act(async () => {
        preloads.resolveAll();
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.fourth));
    expect(preloads.callsFor(mediaUrl(ids.second))).toBe(2);

    await act(async () => {
      preloads.resolveAll();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
  });
});

const advanceTime = async (milliseconds: number): Promise<void> => {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
};

const controlledPreloader = () => {
  const requests: {
    url: string;
    signal: AbortSignal | undefined;
    resolve: () => void;
  }[] = [];
  const preloadImage = vi.fn(
    (url: string, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        // Intentionally ignore cancellation to exercise obsolete completions.
        requests.push({ url, signal, resolve });
      }),
  );
  const resolve = async (url: string, attempt = 0): Promise<void> => {
    const request = requests.filter((request) => request.url === url)[attempt];
    expect(request).toBeDefined();
    await act(async () => request!.resolve());
  };
  return { preloadImage, requests, resolve };
};

describe('Gallery slide deadlines', () => {
  beforeEach(() => vi.useFakeTimers());

  it.each([
    {
      name: 'one appended photo at the default poll interval',
      interval: 30_000,
      additions: 1,
    },
    { name: 'repeated playlist additions', interval: 10_000, additions: 5 },
  ])(
    'preserves the original deadline after $name',
    async ({ interval, additions }) => {
      let playlist = createPlaylist([ids.first, ids.second], {
        slideDurationMs: 60_000,
      });
      const client = { getPlaylist: vi.fn(async () => playlist) };
      const preloadImage = vi.fn();
      render(
        <Gallery
          apiBaseUrl="http://gallery.test"
          client={client}
          preloadImage={preloadImage}
          refreshIntervalMs={interval}
        />,
      );
      await flushPromises();
      const first = currentImage();

      for (let index = 0; index < additions; index += 1) {
        const addedId = `00000000-0000-4000-8000-${String(index + 3).padStart(12, '0')}`;
        playlist = createPlaylist(
          [...playlist.items.map(({ id }) => id), addedId],
          playlist.settings,
        );
        await advanceTime(interval);
        expect(currentImage()).toBe(first);
      }

      await advanceTime(60_000 - interval * additions - 1);
      expect(currentImage()).toBe(first);
      await advanceTime(1);
      expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
      expect(renderedImages()[1]).toBe(first);
      await advanceTime(800);
      expect(renderedImages()).toHaveLength(1);
    },
  );

  it('starts a new duration when the slide timing setting changes', async () => {
    let playlist = createPlaylist([ids.first, ids.second], {
      slideDurationMs: 60_000,
    });
    const client = { getPlaylist: vi.fn(async () => playlist) };
    const preloadImage = vi.fn();
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
      />,
    );
    await flushPromises();
    playlist = createPlaylist([ids.first, ids.second], {
      slideDurationMs: 20_000,
    });
    await advanceTime(30_000);
    await advanceTime(19_999);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    await advanceTime(1);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
  });

  it('does not renew an expired deadline when a usable candidate is added', async () => {
    let playlist = createPlaylist([ids.first, ids.second], {
      slideDurationMs: 60_000,
    });
    const client = { getPlaylist: vi.fn(async () => playlist) };
    const preloadImage = vi.fn(async (url: string) => {
      if (url === mediaUrl(ids.second)) throw new Error('unavailable');
    });
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
        refreshIntervalMs={1_000}
      />,
    );
    await flushPromises();
    await advanceTime(61_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    playlist = createPlaylist(
      [ids.first, ids.second, ids.third],
      playlist.settings,
    );
    await advanceTime(1_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
  });
});

describe('Gallery image failure recovery', () => {
  beforeEach(() => vi.useFakeTimers());

  it.each([false, true])(
    'rejects failed decode even when download metadata is available: %s',
    async (metadataAvailable) => {
      vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(
        metadataAvailable,
      );
      vi.spyOn(
        HTMLImageElement.prototype,
        'naturalWidth',
        'get',
      ).mockReturnValue(metadataAvailable ? 1_920 : 0);
      vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(
        async function (this: HTMLImageElement) {
          if (this.src === mediaUrl(ids.second))
            throw new Error('decode failed');
        },
      );
      const client = {
        getPlaylist: vi.fn().mockResolvedValue(
          createPlaylist([ids.first, ids.second, ids.third], {
            slideDurationMs: 1_000,
          }),
        ),
      };
      render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
      await flushPromises();
      const first = currentImage();
      await advanceTime(1_000);
      expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
      expect(renderedImages()[1]).toBe(first);
      await advanceTime(800);
      expect(renderedImages()).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'allows a six-second load to recover after timeout with an existing photo: %s',
    async (hasCurrentPhoto) => {
      const preloadImage = vi.fn((url: string, signal?: AbortSignal) => {
        if (url === mediaUrl(ids.first)) return;
        return new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 6_000);
          signal?.addEventListener('abort', () => window.clearTimeout(timer), {
            once: true,
          });
        });
      });
      const client = {
        getPlaylist: vi
          .fn()
          .mockResolvedValue(
            createPlaylist(
              hasCurrentPhoto ? [ids.first, ids.second] : [ids.second],
              { slideDurationMs: 1_000 },
            ),
          ),
      };
      render(
        <Gallery
          apiBaseUrl="http://gallery.test"
          client={client}
          preloadImage={preloadImage}
        />,
      );
      await flushPromises();
      // React must commit the retry mount before its six-second load starts.
      await advanceTime(5_000);
      await advanceTime(5_000);
      await advanceTime(5_999);
      if (hasCurrentPhoto) {
        expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
      } else {
        expect(renderedImages()).toHaveLength(0);
      }
      await advanceTime(1);
      expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
      expect(
        preloadImage.mock.calls.filter(([url]) => url === mediaUrl(ids.second)),
      ).toHaveLength(2);
    },
  );

  it('gives a slow photo longer attempts even while other photos keep advancing, then resets on success', async () => {
    const attempts: AbortSignal[] = [];
    const preloadImage = vi.fn((url: string, signal?: AbortSignal) => {
      if (url !== mediaUrl(ids.second)) return;
      attempts.push(signal!);
      return new Promise<void>((resolve) => {
        if (attempts.length > 2) return;
        const timer = window.setTimeout(resolve, 6_000);
        signal?.addEventListener('abort', () => window.clearTimeout(timer), {
          once: true,
        });
      });
    });
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second, ids.third], {
          slideDurationMs: 1_000,
        }),
      ),
    };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
      />,
    );
    await flushPromises();
    await advanceTime(5_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
    await advanceTime(1_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    await advanceTime(5_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
    await advanceTime(1_000);
    expect(attempts).toHaveLength(3);
    await advanceTime(4_999);
    expect(attempts[2]?.aborted).toBe(false);
    await advanceTime(1);
    expect(attempts[2]?.aborted).toBe(true);
  });

  it('caps increasing attempt timeouts and retains the retry pause for a permanently stalled photo', async () => {
    const preloads = controlledPreloader();
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(createPlaylist([ids.first])),
    };
    const view = render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
      />,
    );
    await flushPromises();
    for (const [index, timeout] of [
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ].entries()) {
      expect(preloads.requests).toHaveLength(index + 1);
      await advanceTime(timeout - 1);
      expect(preloads.requests[index]?.signal?.aborted).toBe(false);
      await advanceTime(1);
      expect(preloads.requests[index]?.signal?.aborted).toBe(true);
      await advanceTime(4_999);
      expect(preloads.requests).toHaveLength(index + 1);
      await advanceTime(1);
    }
    expect(renderedImages()).toHaveLength(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a stalled photo and ignores its completion after the timeout', async () => {
    const preloads = controlledPreloader();
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second, ids.third], {
          slideDurationMs: 1_000,
        }),
      ),
    };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
      />,
    );
    await flushPromises();
    await preloads.resolve(mediaUrl(ids.first));
    await preloads.resolve(mediaUrl(ids.third));
    await advanceTime(4_999);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    await advanceTime(1);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
    expect(
      preloads.requests.find(({ url }) => url === mediaUrl(ids.second))?.signal
        ?.aborted,
    ).toBe(true);
    await preloads.resolve(mediaUrl(ids.second));
    await advanceTime(800);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
    expect(renderedImages()).toHaveLength(1);
  });

  it('searches beyond the preload window without exceeding two active attempts', async () => {
    let active = 0;
    let peak = 0;
    const preloadImage = vi.fn((url: string, signal?: AbortSignal) => {
      if (url === mediaUrl(ids.first) || url === mediaUrl(ids.fourth)) return;
      active += 1;
      peak = Math.max(peak, active);
      signal?.addEventListener(
        'abort',
        () => {
          active -= 1;
        },
        { once: true },
      );
      return new Promise<void>(() => {});
    });
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second, ids.third, ids.fourth], {
          slideDurationMs: 1_000,
        }),
      ),
    };
    const view = render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
      />,
    );
    await flushPromises();
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    await advanceTime(5_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.fourth));
    expect(peak).toBe(2);
    view.unmount();
    expect(active).toBe(0);
  });

  it('keeps the same image visible while its source changes and applies live settings', async () => {
    const preloads = controlledPreloader();
    let playlist = createPlaylist(
      [ids.first],
      { imageFit: 'contain' },
      { width: 1_080, height: 1_920 },
    );
    const client = { getPlaylist: vi.fn(async () => playlist) };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
        refreshIntervalMs={500}
      />,
    );
    await flushPromises();
    await preloads.resolve(mediaUrl(ids.first));
    const first = currentImage();
    playlist = {
      ...playlist,
      items: playlist.items.map((item) => ({
        ...item,
        contentUrl: '/updated.webp',
      })),
      settings: { ...playlist.settings, imageFit: 'blur', fadeDurationMs: 200 },
    };
    await advanceTime(500);
    expect(currentImage()).toBe(first);
    expect(first).toHaveClass('gallery__image--blurred');
    expect(screen.getByLabelText('Photo gallery')).toHaveStyle(
      '--fade-duration: 200ms',
    );
    await preloads.resolve('http://gallery.test/updated.webp');
    expect(currentImage()).toHaveAttribute(
      'src',
      'http://gallery.test/updated.webp',
    );
    expect(renderedImages()[1]).toBe(first);
    await advanceTime(200);
    expect(renderedImages()).toHaveLength(1);
  });

  it('retains the last photo, bounds retries across identical polls, and recovers automatically', async () => {
    let recovered = false;
    const preloadImage = vi.fn(async (url: string) => {
      if (url !== mediaUrl(ids.first) && !recovered) throw new Error('offline');
    });
    const client = {
      // A fresh response object must not bypass the retry delay.
      getPlaylist: vi.fn(async () =>
        createPlaylist([ids.first, ids.second, ids.third], {
          slideDurationMs: 1_000,
        }),
      ),
    };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
        refreshIntervalMs={500}
      />,
    );
    await flushPromises();
    const first = currentImage();
    await advanceTime(1_000);
    await advanceTime(4_999);
    expect(currentImage()).toBe(first);
    expect(renderedImages()).toHaveLength(1);
    expect(preloadImage.mock.calls.map(([url]) => url)).toEqual([
      mediaUrl(ids.first),
      mediaUrl(ids.second),
      mediaUrl(ids.third),
    ]);
    await advanceTime(1);
    await advanceTime(4_999);
    expect(currentImage()).toBe(first);
    expect(preloadImage).toHaveBeenCalledTimes(5);
    recovered = true;
    await advanceTime(1);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
    await advanceTime(1_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
  });

  it('shows a waiting state until the first successful load and retries a one-photo playlist', async () => {
    let recovered = false;
    const preloadImage = vi.fn(() => {
      if (!recovered) throw new Error('synchronous failure');
    });
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(createPlaylist([ids.first])),
    };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
      />,
    );
    await flushPromises();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for photos to load. Retrying automatically.',
    );
    expect(renderedImages()).toHaveLength(0);
    await advanceTime(4_999);
    expect(preloadImage).toHaveBeenCalledTimes(1);
    recovered = true;
    await advanceTime(1);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await advanceTime(30_000);
    expect(preloadImage).toHaveBeenCalledTimes(2);
  });

  it('bounds stalled attempts and retries without accepting late results from an older attempt', async () => {
    const preloads = controlledPreloader();
    const client = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(createPlaylist([ids.first, ids.second])),
    };
    const view = render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
      />,
    );
    await flushPromises();
    expect(preloads.requests).toHaveLength(2);
    await advanceTime(5_000);
    expect(preloads.requests.every(({ signal }) => signal?.aborted)).toBe(true);
    await advanceTime(4_999);
    expect(preloads.requests).toHaveLength(2);
    await advanceTime(1);
    expect(preloads.requests).toHaveLength(4);
    await preloads.resolve(mediaUrl(ids.first));
    expect(renderedImages()).toHaveLength(0);
    await preloads.resolve(mediaUrl(ids.first), 1);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    view.unmount();
    expect(preloads.requests[3]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await preloads.resolve(mediaUrl(ids.second), 1);
    await advanceTime(60_000);
    expect(preloads.requests).toHaveLength(4);
  });

  it('retains the displayed snapshot through playlist edits and ignores an obsolete source', async () => {
    const preloads = controlledPreloader();
    let playlist = createPlaylist([ids.first, ids.second]);
    const client = { getPlaylist: vi.fn(async () => playlist) };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
        refreshIntervalMs={1_000}
      />,
    );
    await flushPromises();
    await preloads.resolve(mediaUrl(ids.first));
    const first = currentImage();
    playlist = createPlaylist([ids.second]);
    playlist = {
      ...playlist,
      items: playlist.items.map((item) => ({
        ...item,
        contentUrl: '/replacement.webp',
      })),
    };
    await advanceTime(1_000);
    expect(preloads.requests[1]?.signal?.aborted).toBe(true);
    await preloads.resolve(mediaUrl(ids.second));
    expect(currentImage()).toBe(first);
    await preloads.resolve('http://gallery.test/replacement.webp');
    expect(currentImage()).toHaveAttribute(
      'src',
      'http://gallery.test/replacement.webp',
    );
    expect(renderedImages()[1]).toBe(first);
    await advanceTime(800);
    expect(renderedImages()).toHaveLength(1);
  });

  it('ignores an old request even when its ID and URL are removed and then reintroduced', async () => {
    const preloads = controlledPreloader();
    let playlist = createPlaylist([ids.first, ids.second], {
      slideDurationMs: 1_000,
    });
    const client = { getPlaylist: vi.fn(async () => playlist) };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloads.preloadImage}
        refreshIntervalMs={500}
      />,
    );
    await flushPromises();
    await preloads.resolve(mediaUrl(ids.first));
    playlist = createPlaylist([ids.first], { slideDurationMs: 1_000 });
    await advanceTime(500);
    playlist = createPlaylist([ids.first, ids.second], {
      slideDurationMs: 1_000,
    });
    await advanceTime(500);
    await preloads.resolve(mediaUrl(ids.second));
    await advanceTime(1_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    await preloads.resolve(mediaUrl(ids.second), 1);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
  });

  it('preserves shuffled order while skipping failed photos', async () => {
    const preloadImage = vi.fn(async (url: string) => {
      if (url === mediaUrl(ids.third)) throw new Error('unavailable');
    });
    const playlist = createPlaylist(
      [ids.first, ids.second, ids.third, ids.fourth],
      {
        playbackMode: 'shuffle',
        slideDurationMs: 1_000,
      },
    );
    const client = { getPlaylist: vi.fn().mockResolvedValue(playlist) };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        preloadImage={preloadImage}
        random={() => 0}
      />,
    );
    await flushPromises();
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
    await advanceTime(1_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.fourth));
    await advanceTime(1_000);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    expect(playlist.items.map(({ id }) => id)).toEqual([
      ids.first,
      ids.second,
      ids.third,
      ids.fourth,
    ]);
  });

  it('waits for load events without decode support and handles image errors', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: undefined,
    });
    const client = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(createPlaylist([ids.first, ids.second])),
    };
    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();
    expect(renderedImages()).toHaveLength(0);
    const images = [...document.querySelectorAll<HTMLImageElement>('img')];
    await act(async () =>
      images
        .find((image) => image.src === mediaUrl(ids.first))!
        .dispatchEvent(new Event('error')),
    );
    expect(renderedImages()).toHaveLength(0);
    await act(async () => {
      for (const image of images.filter(
        (image) => image.src === mediaUrl(ids.second),
      ))
        image.dispatchEvent(new Event('load'));
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
    expect(images[1]?.onload).toBeNull();
    expect(images[1]?.onerror).toBeNull();
  });

  it('cancels browser preloads and releases image sources on unmount', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(
      () => new Promise(() => {}),
    );
    const client = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(createPlaylist([ids.first, ids.second, ids.third])),
    };
    const view = render(
      <Gallery apiBaseUrl="http://gallery.test" client={client} />,
    );
    await flushPromises();
    const images = [...document.querySelectorAll<HTMLImageElement>('img')];
    expect(images).toHaveLength(4);
    view.unmount();
    expect(
      images.every(
        (image) => !image.hasAttribute('src') && image.onerror === null,
      ),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('coverCropLoss', () => {
  it('reports nothing lost when the photo already matches the screen', () => {
    expect(coverCropLoss(16 / 9, 16 / 9)).toBe(0);
  });

  it('reports the same loss whichever side overhangs', () => {
    expect(coverCropLoss(4 / 3, 16 / 9)).toBeCloseTo(0.25, 5);
    expect(coverCropLoss(16 / 9, 4 / 3)).toBeCloseTo(0.25, 5);
  });
});

describe('resolveSlideLayout', () => {
  const portrait = { height: 1_920, width: 1_080 };
  const wideScreen = 16 / 10;

  it('never crops or blurs in contain mode', () => {
    expect(resolveSlideLayout('contain', portrait, wideScreen)).toBe('contain');
  });

  it('leaves an almost matching photo alone in every mode', () => {
    const almostWide = { height: 1_000, width: 1_601 };

    expect(resolveSlideLayout('blur', almostWide, wideScreen)).toBe('contain');
    expect(resolveSlideLayout('auto', almostWide, wideScreen)).toBe('contain');
  });

  it('fills the mismatch with a blurred backdrop in blur mode', () => {
    expect(resolveSlideLayout('blur', portrait, wideScreen)).toBe('blurred');
    expect(
      resolveSlideLayout('blur', { height: 1_000, width: 1_500 }, wideScreen),
    ).toBe('blurred');
  });

  it('crops in auto mode only while little of the photo is lost', () => {
    expect(
      resolveSlideLayout('auto', { height: 1_000, width: 1_500 }, wideScreen),
    ).toBe('cover');
    expect(
      resolveSlideLayout('auto', { height: 1_000, width: 1_000 }, wideScreen),
    ).toBe('blurred');
    expect(resolveSlideLayout('auto', portrait, wideScreen)).toBe('blurred');
  });

  it('fills a landscape phone photo on both common wide screens', () => {
    const phonePhoto = { height: 3_024, width: 4_032 };

    expect(resolveSlideLayout('auto', phonePhoto, wideScreen)).toBe('cover');
    expect(resolveSlideLayout('auto', phonePhoto, 16 / 9)).toBe('cover');
  });

  it('falls back to contain for unusable dimensions', () => {
    expect(
      resolveSlideLayout('blur', { height: 0, width: 1_080 }, wideScreen),
    ).toBe('contain');
    expect(resolveSlideLayout('blur', portrait, Number.NaN)).toBe('contain');
  });
});

describe('Gallery screen fit', () => {
  const portrait = { height: 1_920, width: 1_080 };

  const renderWithFit = async (
    imageFit: PlaylistResponse['settings']['imageFit'],
    size: { height: number; width: number },
  ): Promise<void> => {
    const client: PlaylistClient = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(createPlaylist([ids.first], { imageFit }, size)),
    };

    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();
  };

  it('backs a mismatching photo with a blurred copy of the same image', async () => {
    await renderWithFit('blur', portrait);

    const [backdrop] = backdropImages();
    expect(backdrop).toBeDefined();
    expect(backdrop).toHaveAttribute(
      'src',
      currentImage().getAttribute('src') as string,
    );
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(currentImage()).toHaveClass('gallery__image--blurred');
  });

  it('leaves the black bars in place in contain mode', async () => {
    await renderWithFit('contain', portrait);

    expect(backdropImages()).toHaveLength(0);
    expect(currentImage()).toHaveClass('gallery__image--contain');
  });

  it('crops a nearly matching photo in auto mode', async () => {
    await renderWithFit('auto', { height: 1_000, width: 1_400 });

    expect(backdropImages()).toHaveLength(0);
    expect(currentImage()).toHaveClass('gallery__image--cover');
  });

  it('drops the backdrop once the viewport matches the photo', async () => {
    await renderWithFit('blur', portrait);
    expect(backdropImages()).toHaveLength(1);

    await resizeViewport(portrait.width, portrait.height);

    expect(backdropImages()).toHaveLength(0);
    expect(currentImage()).toHaveClass('gallery__image--contain');
  });
});

describe('Gallery retained image elements', () => {
  beforeEach(() => vi.useFakeTimers());

  const decodeTracker = () => {
    const pending = new Map<
      HTMLImageElement,
      { resolve: () => void; reject: () => void }
    >();
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (
      this: HTMLImageElement,
    ) {
      expect(this.isConnected).toBe(true);
      return new Promise<void>((resolve, reject) => {
        pending.set(this, {
          resolve,
          reject: () => reject(new Error('decode failed')),
        });
      });
    });
    const finish = async (image: HTMLImageElement, failed = false) => {
      expect(pending.has(image)).toBe(true);
      await act(async () =>
        failed ? pending.get(image)!.reject() : pending.get(image)!.resolve(),
      );
    };
    const finishSource = async (source: string) => {
      await act(async () => {
        for (const [image, request] of pending)
          if (image.src === source) request.resolve();
      });
    };
    return { pending, finish, finishSource };
  };

  it('hands the exact decoded foreground and backdrop to display only after both are ready', async () => {
    const decodes = decodeTracker();
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second], {
          imageFit: 'blur',
          slideDurationMs: 1_000,
        }),
      ),
    };
    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();
    await decodes.finishSource(mediaUrl(ids.first));
    const first = currentImage();
    const next = document.querySelector<HTMLImageElement>(
      'img[data-state="prepared"]',
    )!;
    const backdrop =
      next.parentElement!.querySelector<HTMLImageElement>(
        '.gallery__backdrop',
      )!;
    await decodes.finish(next);
    await advanceTime(1_500);
    expect(currentImage()).toBe(first);
    expect(first.parentElement).toHaveClass('gallery__slide--current');
    expect(document.querySelector('.gallery__slide--previous')).toBeNull();
    // Changing layout while waiting must not replace the decoded foreground.
    await resizeViewport(600, 1_000);
    expect(next.isConnected).toBe(true);
    await decodes.finish(backdrop);
    expect(currentImage()).toBe(next);
    expect(next.parentElement!.querySelector('.gallery__backdrop')).toBe(
      backdrop,
    );
    expect(first).toHaveAttribute('data-state', 'previous');
    await advanceTime(800);
    expect(first.isConnected).toBe(false);
    expect(first).not.toHaveAttribute('src');
  });

  it('skips a failed backdrop and ignores its late foreground completion', async () => {
    const decodes = decodeTracker();
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second, ids.third], {
          slideDurationMs: 1_000,
        }),
      ),
    };
    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();
    await decodes.finishSource(mediaUrl(ids.first));
    const first = currentImage();
    const failed = [...decodes.pending.keys()].filter(
      (image) => image.src === mediaUrl(ids.second),
    );
    await decodes.finish(
      failed.find((image) => image.className === 'gallery__backdrop')!,
      true,
    );
    expect(
      failed.every((image) => !image.isConnected && !image.hasAttribute('src')),
    ).toBe(true);
    await advanceTime(1_000);
    await decodes.finish(
      failed.find((image) => image.classList.contains('gallery__image'))!,
    );
    expect(currentImage()).toBe(first);
    await decodes.finishSource(mediaUrl(ids.third));
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.third));
  });

  it('invalidates ready elements on source replacement and reorder', async () => {
    const decodes = decodeTracker();
    let playlist = createPlaylist([ids.first, ids.second, ids.third]);
    const client = { getPlaylist: vi.fn(async () => playlist) };
    render(
      <Gallery
        apiBaseUrl="http://gallery.test"
        client={client}
        refreshIntervalMs={500}
      />,
    );
    await flushPromises();
    await decodes.finishSource(mediaUrl(ids.first));
    await decodes.finishSource(mediaUrl(ids.second));
    const obsolete = [...decodes.pending.keys()].filter(
      (image) => image.src === mediaUrl(ids.second),
    );
    playlist = createPlaylist([ids.first, ids.third, ids.second]);
    playlist.items[1]!.contentUrl = '/changed.webp';
    await advanceTime(500);
    expect(
      obsolete.every(
        (image) => !image.isConnected && !image.hasAttribute('src'),
      ),
    ).toBe(true);
    await advanceTime(3_500);
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    await decodes.finishSource('http://gallery.test/changed.webp');
    expect(currentImage()).toHaveAttribute(
      'src',
      'http://gallery.test/changed.webp',
    );
  });

  it.each([4, 100])(
    'bounds mounted layers with %i playlist items and releases them on an empty playlist',
    async (count) => {
      const itemIds = Array.from(
        { length: count },
        (_, index) => `photo-${index}`,
      );
      let playlist = createPlaylist(itemIds, { slideDurationMs: 1_000 });
      const client = { getPlaylist: vi.fn(async () => playlist) };
      render(
        <Gallery
          apiBaseUrl="http://gallery.test"
          client={client}
          refreshIntervalMs={500}
        />,
      );
      await flushPromises();
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const current = currentImage();
        const nextId = itemIds[(cycle + 1) % count]!;
        const next = [
          ...document.querySelectorAll<HTMLImageElement>(
            'img[data-state="prepared"]',
          ),
        ].find((image) => image.src === mediaUrl(nextId));
        await advanceTime(cycle === 0 ? 1_000 : 200);
        expect(currentImage()).toBe(next);
        expect(
          document.querySelectorAll('.gallery__slide').length,
        ).toBeLessThanOrEqual(4);
        expect(document.querySelectorAll('img').length).toBeLessThanOrEqual(8);
        await advanceTime(800);
        expect(current.isConnected).toBe(false);
        expect(current).not.toHaveAttribute('src');
      }
      const remaining = [...document.querySelectorAll('img')];
      playlist = createPlaylist([]);
      await advanceTime(500);
      expect(document.querySelectorAll('img')).toHaveLength(0);
      expect(remaining.every((image) => !image.hasAttribute('src'))).toBe(true);
    },
  );

  it('keeps retained slide containers in DOM order across handoffs and repeated cycles', async () => {
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(
        createPlaylist([ids.first, ids.second, ids.third], {
          slideDurationMs: 1_000,
        }),
      ),
    };
    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();
    for (let handoff = 0; handoff < 8; handoff += 1) {
      const before = [...document.querySelectorAll('.gallery__slide')];
      await advanceTime(1_000);
      const after = [...document.querySelectorAll('.gallery__slide')];
      expect(after.filter((slide) => before.includes(slide))).toEqual(
        before.filter((slide) => after.includes(slide)),
      );
    }
  });

  it('prepares mounted elements successfully under StrictMode effect replay', async () => {
    const client = {
      getPlaylist: vi
        .fn()
        .mockResolvedValue(
          createPlaylist([ids.first, ids.second], { slideDurationMs: 1_000 }),
        ),
    };
    const view = render(
      <StrictMode>
        <Gallery apiBaseUrl="http://gallery.test" client={client} />
      </StrictMode>,
    );
    await flushPromises();
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));
    const next = document.querySelector('img[data-state="prepared"]');
    await advanceTime(1_000);
    expect(currentImage()).toBe(next);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects readiness for a different selected source', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'currentSrc', 'get').mockReturnValue(
      'http://gallery.test/stale.webp',
    );
    const client = {
      getPlaylist: vi.fn().mockResolvedValue(createPlaylist([ids.first])),
    };
    render(<Gallery apiBaseUrl="http://gallery.test" client={client} />);
    await flushPromises();
    expect(renderedImages()).toHaveLength(0);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for photos');
  });
});
