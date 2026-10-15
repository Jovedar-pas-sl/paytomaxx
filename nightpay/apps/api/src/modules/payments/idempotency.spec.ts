import { describe, it, expect } from 'vitest';
import { idempotencyHashOf, sameIdempotentRequest, stableJson } from './idempotency';

describe('huella de la petición (Idempotency-Key)', () => {
  const body = { amountCents: 5000, currency: 'EUR', zone: 'BARRA', wallet: { create: true, identifier: 'x' } };

  it('la misma petición de la misma persona → la misma huella, aunque cambie el orden', () => {
    const reordered = { wallet: { identifier: 'x', create: true }, zone: 'BARRA', currency: 'EUR', amountCents: 5000 };
    expect(idempotencyHashOf('user-1', body)).toBe(idempotencyHashOf('user-1', reordered));
  });

  it('otra persona u otro importe → otra huella', () => {
    expect(idempotencyHashOf('user-2', body)).not.toBe(idempotencyHashOf('user-1', body));
    expect(idempotencyHashOf('user-1', { ...body, amountCents: 5001 })).not.toBe(idempotencyHashOf('user-1', body));
  });

  it('un campo sin valor (undefined) es como no mandarlo', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }));
  });

  it('cobro con huella: vale solo la misma petición', () => {
    const hash = idempotencyHashOf('user-1', body);
    expect(sameIdempotentRequest({ idempotencyHash: hash, createdByUserId: 'user-1' }, hash, 'user-1')).toBe(true);
    const other = idempotencyHashOf('user-1', { ...body, amountCents: 1 });
    expect(sameIdempotentRequest({ idempotencyHash: hash, createdByUserId: 'user-1' }, other, 'user-1')).toBe(false);
  });

  it('cobro de antes de la huella: al menos tiene que ser la misma persona', () => {
    const old = { idempotencyHash: null, createdByUserId: 'user-1' };
    expect(sameIdempotentRequest(old, 'cualquiera', 'user-1')).toBe(true);
    expect(sameIdempotentRequest(old, 'cualquiera', 'user-2')).toBe(false);
  });
});
