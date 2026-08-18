import { describe, expect, it } from 'vitest';

describe('multiple failures', () => {
  it('keeps the first failure', () => expect('alpha').toBe('beta'));
  it('keeps the second failure', () => expect([1, 2]).toEqual([1, 3]));
  it('still counts a pass', () => expect(true).toBe(true));
});
