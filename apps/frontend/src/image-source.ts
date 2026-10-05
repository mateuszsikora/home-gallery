import type { PlaylistItem } from '@home-gallery/shared-types';

export interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
}

/** Choose the smallest image that covers the actual foreground pixel footprint. */
export const selectImageSource = (
  item: PlaylistItem,
  layout: 'contain' | 'cover' | 'blurred',
  viewport: Viewport,
): string => {
  const scale =
    (layout === 'cover' ? Math.max : Math.min)(
      viewport.width / item.width,
      viewport.height / item.height,
    ) * viewport.pixelRatio;
  // Blurred backgrounds intentionally share the foreground source: their
  // quarter-size, heavily blurred layer does not need a second high-res fetch.
  const width = Math.min(item.width, Math.round(item.width * scale));
  const height = Math.min(item.height, Math.round(item.height * scale));
  return (
    [...(item.variants ?? [])]
      .sort(
        (left, right) => left.width * left.height - right.width * right.height,
      )
      .find((variant) => variant.width >= width && variant.height >= height)
      ?.contentUrl ?? item.contentUrl
  );
};
