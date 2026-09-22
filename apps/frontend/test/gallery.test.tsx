// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const renderedImages = (): HTMLImageElement[] => [
  ...document.querySelectorAll<HTMLImageElement>('img[data-state]'),
];

const backdropImages = (): HTMLImageElement[] => [
  ...document.querySelectorAll<HTMLImageElement>('img.gallery__backdrop'),
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
      );
    });
    expect(preloadImage).toHaveBeenCalledWith(
      `http://api.test:3012/media/${ids.third}`,
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

  it('moves on when an upcoming photo never arrives', async () => {
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.first));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(currentImage()).toHaveAttribute('src', mediaUrl(ids.second));
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
