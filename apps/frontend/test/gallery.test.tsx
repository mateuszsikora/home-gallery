// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaylistResponse } from '@home-gallery/shared-types';

import { Gallery, type PlaylistClient } from '../src/gallery.js';

const ids = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  third: '00000000-0000-4000-8000-000000000003',
} as const;

const createPlaylist = (
  itemIds: readonly string[],
  overrides: Partial<PlaylistResponse['settings']> = {},
): PlaylistResponse => ({
  items: itemIds.map((id) => ({
    id,
    contentUrl: `/media/${id}`,
    mimeType: 'image/webp',
    width: 1_920,
    height: 1_080,
  })),
  settings: {
    slideDurationMs: 4_000,
    fadeDurationMs: 800,
    playbackMode: 'sequential',
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
});
