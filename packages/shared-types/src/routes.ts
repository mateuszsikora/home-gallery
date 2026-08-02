export const ADMIN_SESSION_CSRF_HEADER = 'x-home-gallery-csrf';
export const ADMIN_SESSION_CSRF_VALUE = '1';

export const API_ROUTES = {
  adminSession: '/api/admin/session',
  health: '/health',
  media: '/api/media',
  playlist: '/api/playlist',
  settings: '/api/settings',
  mediaById: (id: string): string => `/api/media/${encodeURIComponent(id)}`,
  mediaContentById: (id: string): string => `/media/${encodeURIComponent(id)}`,
} as const;
