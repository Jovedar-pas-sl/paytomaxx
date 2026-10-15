import { describe, it, expect } from 'vitest';
import { ConfirmManualSchema } from './treasury.controller';

describe('ConfirmManualSchema — justificante solo por https', () => {
  it('javascript:, data: o http: no; https sí', () => {
    for (const receiptUrl of ['javascript:alert(1)', 'data:text/html,hola', 'http://example.com/r.pdf']) {
      expect(ConfirmManualSchema.safeParse({ receiptUrl }).success).toBe(false);
    }
    expect(ConfirmManualSchema.safeParse({ receiptUrl: 'https://example.com/r.pdf' }).success).toBe(true);
    expect(ConfirmManualSchema.safeParse({ notes: 'pagado en mano' }).success).toBe(true);
  });
});
