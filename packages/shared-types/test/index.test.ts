import { describe, expect, it } from 'vitest';

import { componentName } from '../src/index.js';

describe('@home-gallery/shared-types', () => {
  it('exposes its workspace identity', () => {
    expect(componentName).toBe('@home-gallery/shared-types');
  });
});
