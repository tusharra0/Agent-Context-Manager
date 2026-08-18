import { describe, expect, it } from 'vitest';

describe('account balance', () => {
  it('preserves cents', () =>
    expect({ amount: 10.01 }).toEqual({ amount: 10.02 }));
});
