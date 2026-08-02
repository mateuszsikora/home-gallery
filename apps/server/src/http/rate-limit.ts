import type { RateLimitConfig } from '@home-gallery/config';
import type {
  FastifyReply,
  FastifyRequest,
  onRequestHookHandler,
} from 'fastify';

import { ApiError } from './errors.js';

const MAX_TRACKED_CLIENTS = 10_000;
const OVERFLOW_KEY = '<overflow>';

interface RateLimitWindow {
  count: number;
  resetAt: number;
  rejectionReported: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  firstRejection: boolean;
  retryAfterSeconds: number;
}

/**
 * A bounded in-memory fixed-window limiter. New clients share an overflow
 * bucket after the map reaches its cap, preventing forged identities from
 * turning rate-limit state into an unbounded memory allocation.
 */
export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, RateLimitWindow>();

  constructor(
    readonly config: RateLimitConfig,
    readonly now: () => number = Date.now,
  ) {}

  consume(clientId: string): RateLimitResult {
    const now = this.now();
    let key = clientId;
    let window = this.#windows.get(key);

    if (window === undefined && this.#windows.size >= MAX_TRACKED_CLIENTS - 1) {
      const overflow = this.#windows.get(OVERFLOW_KEY);

      if (overflow !== undefined && overflow.resetAt > now) {
        key = OVERFLOW_KEY;
        window = overflow;
      } else {
        for (const [candidate, value] of this.#windows) {
          if (value.resetAt <= now) {
            this.#windows.delete(candidate);
          }
        }

        if (this.#windows.size >= MAX_TRACKED_CLIENTS - 1) {
          key = OVERFLOW_KEY;
          window = this.#windows.get(key);
        }
      }
    }

    if (window === undefined || window.resetAt <= now) {
      this.#windows.set(key, {
        count: 1,
        resetAt: now + this.config.windowMs,
        rejectionReported: false,
      });
      return {
        allowed: true,
        firstRejection: false,
        retryAfterSeconds: 0,
      };
    }

    if (window.count >= this.config.max) {
      const firstRejection = !window.rejectionReported;
      window.rejectionReported = true;
      return {
        allowed: false,
        firstRejection,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1_000),
        ),
      };
    }

    window.count += 1;
    return { allowed: true, firstRejection: false, retryAfterSeconds: 0 };
  }
}

export const rejectWhenRateLimited = (
  result: RateLimitResult,
  reply: FastifyReply,
  message: string,
): void => {
  if (result.allowed) {
    return;
  }

  void reply.header('retry-after', result.retryAfterSeconds.toString());
  throw new ApiError('rate_limited', message);
};

export const createRequestRateLimitHook =
  (limiter: FixedWindowRateLimiter, message: string): onRequestHookHandler =>
  (request: FastifyRequest, reply: FastifyReply, done): void => {
    try {
      const result = limiter.consume(request.ip);

      if (!result.allowed && result.firstRejection) {
        request.log.warn(
          {
            clientAddress: request.ip,
            limit: limiter.config.max,
            windowMs: limiter.config.windowMs,
          },
          message,
        );
      }

      rejectWhenRateLimited(result, reply, message);
      done();
    } catch (error) {
      done(error as Error);
    }
  };
