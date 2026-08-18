import { expect, it } from 'vitest';

it('provides recognized expected and actual delimiters', () => {
  expect('observed-value').toBe('expected-value');
});
