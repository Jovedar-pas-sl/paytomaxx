import { describe, it, expect } from 'vitest';
import { BRAND_NAME } from './brand';

describe('marca', () => {
  it('por defecto OxioPay', () => {
    expect(BRAND_NAME).toBe(process.env.BRAND_NAME?.trim() || 'OxioPay');
  });
});
