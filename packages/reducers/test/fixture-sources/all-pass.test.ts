import { describe, expect, it } from 'vitest';

describe('calculator', () => {
  it('adds values', () => expect(1 + 2).toBe(3));
  it.skip('has a deferred scenario', () => undefined);
  it.todo('handles arbitrary precision');
});
