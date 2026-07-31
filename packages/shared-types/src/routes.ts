export const API_ROUTES = {
  health: '/health',
  media: '/api/media',
  playlist: '/api/playlist',
  settings: '/api/settings',
  mediaById: (id: string): string => `/api/media/${encodeURIComponent(id)}`,
  mediaContentById: (id: string): string => `/media/${encodeURIComponent(id)}`,
} as const;
