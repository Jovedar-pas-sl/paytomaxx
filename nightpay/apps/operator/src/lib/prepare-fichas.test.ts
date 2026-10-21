import { describe, expect, it } from 'vitest';
import { needsPrintedNumber } from './prepare-fichas';
describe('factory number preparation', () => {
  it('pauses only unlabelled eligible staff cards', () => {
    expect(needsPrintedNumber('staff', { outcome: 'stocked' })).toBe(true);
    expect(needsPrintedNumber('staff', { outcome: 'already' })).toBe(true);
    expect(needsPrintedNumber('staff', { outcome: 'returned', codeHint: 'ABC' })).toBe(true);
    expect(needsPrintedNumber('staff', { outcome: 'stocked', printedNumber: '000522' })).toBe(false);
    expect(needsPrintedNumber('staff', { outcome: 'blocked' })).toBe(false);
    expect(needsPrintedNumber('device', { outcome: 'stocked' })).toBe(false);
  });
});
