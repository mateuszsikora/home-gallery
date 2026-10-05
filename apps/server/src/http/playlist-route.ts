import {
  API_ROUTES,
  toPlaylistItem,
  type PlaylistResponse,
} from '@home-gallery/shared-types';
import type { FastifyInstance } from 'fastify';

import { availableDisplayVariants } from '../media/display-variants.js';
import { NO_STORE_CACHE_CONTROL } from './cache.js';

/**
 * The slideshow polls this route, so it stays public and uncached: an operator
 * who disables a photo expects the next poll to drop it. Items are returned in
 * storage order; `settings.playbackMode` tells the client whether to shuffle,
 * which keeps the response deterministic and testable.
 */
export const registerPlaylistRoute = (app: FastifyInstance): void => {
  app.get(API_ROUTES.playlist, async (request, reply) => {
    const items = [];
    for (const record of app.mediaRepository.listEnabled()) {
      const variants = await availableDisplayVariants(record, app.mediaStorage);
      // Visibility may change while reading the filesystem.
      if (app.mediaRepository.findById(record.id)?.enabled !== true) continue;
      items.push({
        ...toPlaylistItem(record),
        ...(variants.length > 0 ? { variants } : {}),
      });
    }
    const playlist: PlaylistResponse = {
      items,
      settings: app.settingsRepository.read(),
    };

    return reply.header('cache-control', NO_STORE_CACHE_CONTROL).send(playlist);
  });
};
