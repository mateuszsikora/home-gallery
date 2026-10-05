import { describe, expect, it } from 'vitest';
import type { PlaylistItem } from '@home-gallery/shared-types';
import { selectImageSource } from '../src/image-source.js';

const photo: PlaylistItem = {
  id: '00000000-0000-4000-8000-000000000001',
  contentUrl: '/full',
  mimeType: 'image/webp',
  width: 6000,
  height: 4000,
  variants: [
    { contentUrl: '/1280', width: 1280, height: 853 },
    { contentUrl: '/1920', width: 1920, height: 1280 },
    { contentUrl: '/2560', width: 2560, height: 1707 },
  ],
};

describe('display source selection', () => {
  it.each([
    ['contain', 1280, 800, 1, '/1280'],
    ['cover', 1280, 800, 1, '/1280'],
    ['contain', 1280, 800, 2, '/2560'],
    ['contain', 1920, 1080, 1, '/1920'],
    ['cover', 1920, 1080, 1, '/1920'],
    ['contain', 800, 1280, 1, '/1280'],
    ['cover', 800, 1280, 1, '/1920'],
    ['blurred', 800, 1280, 1, '/1280'],
    ['contain', 3840, 2160, 1, '/full'],
  ] as const)(
    'selects %s at %dx%d DPR %d',
    (layout, width, height, pixelRatio, expected) => {
      expect(
        selectImageSource(photo, layout, { width, height, pixelRatio }),
      ).toBe(expected);
    },
  );
  it('sizes portrait photos by their rendered height and keeps cover sharp', () => {
    const portrait = {
      ...photo,
      width: photo.height,
      height: photo.width,
      variants: photo.variants!.map((variant) => ({
        ...variant,
        width: variant.height,
        height: variant.width,
      })),
    };
    expect(
      selectImageSource(portrait, 'contain', {
        width: 1280,
        height: 800,
        pixelRatio: 1,
      }),
    ).toBe('/1280');
    expect(
      selectImageSource(portrait, 'cover', {
        width: 1280,
        height: 800,
        pixelRatio: 1,
      }),
    ).toBe('/1920');
  });
  it('supports old playlists, missing variants and small sources', () => {
    expect(
      selectImageSource({ ...photo, variants: [] }, 'contain', {
        width: 800,
        height: 600,
        pixelRatio: 1,
      }),
    ).toBe('/full');
    const legacy = { ...photo };
    delete legacy.variants;
    expect(
      selectImageSource(legacy, 'contain', {
        width: 800,
        height: 600,
        pixelRatio: 1,
      }),
    ).toBe('/full');
    expect(
      selectImageSource({ ...legacy, width: 100, height: 50 }, 'cover', {
        width: 800,
        height: 600,
        pixelRatio: 2,
      }),
    ).toBe('/full');
  });
});
