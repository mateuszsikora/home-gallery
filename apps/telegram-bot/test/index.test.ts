import { describe, expect, it } from 'vitest';

import { componentName } from '../src/index.js';

describe('@home-gallery/telegram-bot', () => {
  it('exposes its workspace identity', () => {
    expect(componentName).toBe('@home-gallery/telegram-bot');
  });
});
