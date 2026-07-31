/**
 * Administrative and playlist responses describe mutable state, so a client
 * must always ask the server instead of reusing a stored copy.
 */
export const NO_STORE_CACHE_CONTROL = 'no-store';

/**
 * Normalized media bytes are addressed by an identifier that is never reused,
 * so a client may keep them for as long as it likes.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
