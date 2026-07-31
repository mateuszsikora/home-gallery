// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeGalleryApiError } from '@home-gallery/api-client';
import type { GallerySettings, MediaRecord } from '@home-gallery/shared-types';

import {
  AdminApp,
  SESSION_TOKEN_KEY,
  type AdminClient,
} from '../src/admin-app.js';

const ids = {
  first: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
} as const;

const mediaRecord = (
  id: string,
  originalFilename: string,
  sortOrder: number,
  enabled = true,
): MediaRecord => ({
  id,
  storedFilename: `${id}.webp`,
  originalFilename,
  mediaType: 'image',
  mimeType: 'image/webp',
  uploadedAt: `2026-07-31T10:1${sortOrder}:30.000Z`,
  source: sortOrder === 0 ? 'telegram' : 'admin',
  ...(sortOrder === 0
    ? { sourceId: '123456', authorName: 'Gallery contributor' }
    : { authorName: 'Administrator' }),
  enabled,
  sortOrder,
  width: 1_920,
  height: 1_080,
});

const firstMedia = mediaRecord(ids.first, 'summer.jpg', 0);
const secondMedia = mediaRecord(ids.second, 'forest.png', 1, false);
const settings: GallerySettings = {
  slideDurationMs: 8_000,
  fadeDurationMs: 1_000,
  playbackMode: 'sequential',
};

interface ClientMocks {
  readonly client: AdminClient;
  readonly deleteMedia: ReturnType<typeof vi.fn>;
  readonly getSettings: ReturnType<typeof vi.fn>;
  readonly listMedia: ReturnType<typeof vi.fn>;
  readonly updateMedia: ReturnType<typeof vi.fn>;
  readonly updateSettings: ReturnType<typeof vi.fn>;
  readonly uploadMedia: ReturnType<typeof vi.fn>;
}

const createClientMocks = (
  items: readonly MediaRecord[] = [firstMedia, secondMedia],
): ClientMocks => {
  const listMedia = vi.fn().mockResolvedValue({ items, nextCursor: null });
  const getSettings = vi.fn().mockResolvedValue(settings);
  const uploadMedia = vi.fn().mockResolvedValue(firstMedia);
  const updateMedia = vi
    .fn()
    .mockImplementation(
      async (id: string, update: { enabled?: boolean; sortOrder?: number }) => {
        const item =
          items.find((candidate) => candidate.id === id) ?? firstMedia;
        return { ...item, ...update };
      },
    );
  const deleteMedia = vi.fn().mockResolvedValue(undefined);
  const updateSettings = vi
    .fn()
    .mockImplementation(async (update: Partial<GallerySettings>) => ({
      ...settings,
      ...update,
    }));

  return {
    client: {
      deleteMedia,
      getMediaContentUrl: (id) => `http://api.test/media/${id}`,
      getSettings,
      listMedia,
      updateMedia,
      updateSettings,
      uploadMedia,
    },
    deleteMedia,
    getSettings,
    listMedia,
    updateMedia,
    updateSettings,
    uploadMedia,
  };
};

const openStudio = async (client: AdminClient): Promise<void> => {
  const user = userEvent.setup();
  const createClient = vi.fn().mockReturnValue(client);
  render(<AdminApp apiBaseUrl="http://api.test" createClient={createClient} />);

  await user.type(screen.getByLabelText('Access token'), 'private-token');
  await user.click(screen.getByRole('button', { name: 'Open studio' }));
  expect(
    await screen.findByRole('heading', { name: 'Photos on rotation' }),
  ).toBeVisible();
  expect(createClient).toHaveBeenCalledWith('private-token');
};

const mediaCard = (filename: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name: filename });
  const card = heading.closest('article');

  if (card === null) {
    throw new Error(`Media card for ${filename} was not rendered`);
  }

  return card;
};

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe('AdminApp', () => {
  it('rejects an invalid token without persisting it and focuses the error', async () => {
    const user = userEvent.setup();
    const unauthorized = new HomeGalleryApiError(401, 'Invalid bearer token', {
      error: { code: 'unauthorized', message: 'Invalid bearer token' },
    });
    const mocks = createClientMocks([]);
    mocks.listMedia.mockRejectedValue(unauthorized);

    render(
      <AdminApp
        apiBaseUrl="http://api.test"
        createClient={() => mocks.client}
      />,
    );
    await user.type(screen.getByLabelText('Access token'), 'wrong-token');
    await user.click(screen.getByRole('button', { name: 'Open studio' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('access token was rejected');
    expect(alert).toHaveFocus();
    expect(window.sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(window.location.href).not.toContain('wrong-token');
  });

  it('restores a session credential and presents the empty library state', async () => {
    const mocks = createClientMocks([]);
    window.sessionStorage.setItem(SESSION_TOKEN_KEY, 'session-token');
    const createClient = vi.fn().mockReturnValue(mocks.client);

    render(
      <AdminApp apiBaseUrl="http://api.test" createClient={createClient} />,
    );

    expect(
      await screen.findByRole('heading', {
        name: 'The first frame is waiting.',
      }),
    ).toBeVisible();
    expect(createClient).toHaveBeenCalledWith('session-token');
    expect(screen.getByText('0 photos')).toBeVisible();
  });

  it('uploads a selected image through the shared client', async () => {
    const mocks = createClientMocks([]);
    mocks.listMedia
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [firstMedia], nextCursor: null });
    await openStudio(mocks.client);

    const file = new File(['image bytes'], 'new-frame.jpg', {
      type: 'image/jpeg',
    });
    const uploadInput = screen.getByLabelText('Add a photograph');
    fireEvent.change(uploadInput, { target: { files: [file] } });
    const uploadForm = uploadInput.closest('form');

    if (uploadForm === null) {
      throw new Error('Upload form was not rendered');
    }

    fireEvent.submit(uploadForm);

    await waitFor(() => {
      expect(mocks.uploadMedia).toHaveBeenCalledWith({
        file,
        originalFilename: 'new-frame.jpg',
        source: 'admin',
        authorName: 'Administrator',
      });
    });
    expect(
      await screen.findByText(
        'new-frame.jpg was uploaded and added to the gallery.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'summer.jpg' })).toBeVisible();
  });

  it('changes visibility and reorders media deterministically', async () => {
    const user = userEvent.setup();
    const mocks = createClientMocks();
    mocks.listMedia
      .mockResolvedValueOnce({
        items: [firstMedia, secondMedia],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [
          { ...secondMedia, sortOrder: 0 },
          { ...firstMedia, sortOrder: 1 },
        ],
        nextCursor: null,
      });
    await openStudio(mocks.client);

    await user.click(
      within(mediaCard('summer.jpg')).getByRole('button', { name: 'Visible' }),
    );
    await waitFor(() => {
      expect(mocks.updateMedia).toHaveBeenCalledWith(ids.first, {
        enabled: false,
      });
    });

    await user.click(
      within(mediaCard('forest.png')).getByRole('button', { name: 'Hidden' }),
    );
    await waitFor(() => {
      expect(mocks.updateMedia).toHaveBeenCalledWith(ids.second, {
        enabled: true,
      });
    });

    await user.click(
      screen.getByRole('button', { name: 'Move forest.png up' }),
    );
    await waitFor(() => {
      expect(mocks.updateMedia).toHaveBeenCalledWith(ids.second, {
        sortOrder: 0,
      });
    });
    expect(await screen.findByText('forest.png was moved up.')).toBeVisible();
  });

  it('requires focused confirmation and submits deletion only once', async () => {
    const user = userEvent.setup();
    let finishDelete: (() => void) | undefined;
    const mocks = createClientMocks([firstMedia]);
    mocks.deleteMedia.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    mocks.listMedia
      .mockResolvedValueOnce({ items: [firstMedia], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    await openStudio(mocks.client);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmButton = screen.getByRole('button', { name: 'Delete photo' });
    expect(confirmButton).toHaveFocus();

    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    expect(mocks.deleteMedia).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMedia).toHaveBeenCalledWith(ids.first);

    finishDelete?.();
    expect(
      await screen.findByText('summer.jpg was permanently deleted.'),
    ).toBeVisible();
    expect(screen.getByText('0 photos')).toBeVisible();
  });

  it('saves all playback settings and surfaces field validation errors', async () => {
    const user = userEvent.setup();
    const mocks = createClientMocks([]);
    await openStudio(mocks.client);

    const slideDuration = screen.getByLabelText(/Time per photo/);
    const fadeDuration = screen.getByLabelText(/Fade duration/);
    await user.clear(slideDuration);
    await user.type(slideDuration, '12.5');
    await user.clear(fadeDuration);
    await user.type(fadeDuration, '2');
    await user.click(screen.getByRole('radio', { name: /Shuffle/ }));
    await user.click(
      screen.getByRole('button', { name: 'Save playback settings' }),
    );

    await waitFor(() => {
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        slideDurationMs: 12_500,
        fadeDurationMs: 2_000,
        playbackMode: 'shuffle',
      });
    });
    expect(
      await screen.findByText('Playback settings were saved.'),
    ).toBeVisible();

    mocks.updateSettings.mockRejectedValueOnce(
      new HomeGalleryApiError(422, 'Invalid settings', {
        error: {
          code: 'validation_failed',
          message: 'Invalid settings',
          issues: [{ path: 'fadeDurationMs', message: 'Fade is too long' }],
        },
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Save playback settings' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fade is too long',
    );
  });
});
