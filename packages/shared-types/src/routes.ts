export const ADMIN_SESSION_CSRF_HEADER = 'x-home-gallery-csrf';
export const ADMIN_SESSION_CSRF_VALUE = '1';

export const API_ROUTES = {
  adminAuth: '/api/admin/auth',
  adminPassword: '/api/admin/password',
  adminSession: '/api/admin/session',
  health: '/health',
  media: '/api/media',
  playlist: '/api/playlist',
  settings: '/api/settings',
  telegramContributors: '/api/telegram/contributors',
  mediaById: (id: string): string => `/api/media/${encodeURIComponent(id)}`,
  mediaContentById: (id: string): string => `/media/${encodeURIComponent(id)}`,
  adminMediaContentById: (id: string): string =>
    `/api/media/${encodeURIComponent(id)}/content`,
  telegramContributorById: (telegramUserId: string): string =>
    `/api/telegram/contributors/${encodeURIComponent(telegramUserId)}`,
} as const;
