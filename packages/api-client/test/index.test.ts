import { describe, expect, it } from 'vitest';

import { componentName } from '../src/index.js';

describe('@home-gallery/api-client', () => {
  it('exposes its workspace identity', () => {
    expect(componentName).toBe('@home-gallery/api-client');
  });
});
