import { describe, expect, it } from 'vitest';

import { componentName } from '../src/index.js';

describe('@home-gallery/config', () => {
  it('exposes its workspace identity', () => {
    expect(componentName).toBe('@home-gallery/config');
  });
});
