import { describe, expect, it } from 'vitest';

import { formatPercent, formatRatio } from './view-model';

describe('dashboard view model', () => {
  it('formats reductions and ratios without inventing missing measurements', () => {
    expect(formatPercent(31.234)).toBe('31.2%');
    expect(formatRatio(0.9876)).toBe('98.8%');
    expect(formatPercent(null)).toBe('—');
    expect(formatRatio(null)).toBe('—');
  });
});
