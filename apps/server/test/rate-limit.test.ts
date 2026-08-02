import { describe, expect, it } from 'vitest';

import { FixedWindowRateLimiter } from '../src/http/rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('limits clients independently and resets after the window', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(
      { max: 2, windowMs: 5_000 },
      () => now,
    );

    expect(limiter.consume('client-a')).toMatchObject({ allowed: true });
    expect(limiter.consume('client-a')).toMatchObject({ allowed: true });
    expect(limiter.consume('client-b')).toMatchObject({ allowed: true });

    expect(limiter.consume('client-a')).toEqual({
      allowed: false,
      firstRejection: true,
      retryAfterSeconds: 5,
    });
    expect(limiter.consume('client-a')).toEqual({
      allowed: false,
      firstRejection: false,
      retryAfterSeconds: 5,
    });

    now = 6_000;
    expect(limiter.consume('client-a')).toEqual({
      allowed: true,
      firstRejection: false,
      retryAfterSeconds: 0,
    });
  });
});
