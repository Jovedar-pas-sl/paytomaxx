import { describe, expect, it } from 'vitest';
import { amountCents, barMode, doorStep, newSpendKey, tonightInMadrid } from './reservas';

const tonight = '2026-11-21';

describe('la puerta', () => {
  it('pagado entero en su noche: dar la llegada; con el resto pendiente: cobrarlo antes', () => {
    expect(doorStep({ status: 'PAID', pendingCents: 0, nightDate: tonight }, tonight)).toEqual({ kind: 'arrive' });
    expect(doorStep({ status: 'DEPOSIT_PAID', pendingCents: 21000, nightDate: tonight }, tonight)).toEqual({ kind: 'pay-rest', pendingCents: 21000 });
    expect(doorStep({ status: 'ARRIVED', pendingCents: 0, nightDate: tonight }, tonight)).toEqual({ kind: 'arrived' });
  });

  it('sin señal, anulada, «No vino» u otra noche: no pasa', () => {
    expect(doorStep({ status: 'PENDING', pendingCents: 30000, nightDate: tonight }, tonight).kind).toBe('blocked');
    expect(doorStep({ status: 'CANCELED', pendingCents: 0, nightDate: tonight }, tonight).kind).toBe('blocked');
    expect(doorStep({ status: 'CLIENT_CANCELED', pendingCents: 0, nightDate: tonight }, tonight)).toEqual({ kind: 'blocked', reason: 'Anulada por el cliente' });
    expect(doorStep({ status: 'PAID', pendingCents: 0, nightDate: '2026-11-22' }, tonight)).toEqual({ kind: 'blocked', reason: 'Es de otra noche (2026-11-22)' });
  });
});

describe('la barra', () => {
  it('de importe: cobrar del saldo; de cosas: servir; antes de llegar: nada', () => {
    expect(barMode({ status: 'ARRIVED', kind: 'CREDIT', balanceCents: 35000, itemsLeft: [] })).toEqual({ kind: 'credit', balanceCents: 35000 });
    const items = [{ name: 'Botella', qty: 2, left: 1 }];
    expect(barMode({ status: 'ARRIVED', kind: 'ITEMS', balanceCents: 0, itemsLeft: items })).toEqual({ kind: 'items', items });
    expect(barMode({ status: 'PAID', kind: 'CREDIT', balanceCents: null, itemsLeft: [] }).kind).toBe('closed');
  });

  it('importes en céntimos enteros', () => {
    expect(amountCents('12')).toBe(1200);
    expect(amountCents('12,5')).toBe(1250);
    expect(amountCents('0')).toBeNull();
    expect(amountCents('1.234')).toBeNull();
  });

  it('la noche de Madrid y una clave nueva cada vez', () => {
    expect(tonightInMadrid(new Date('2026-11-22T06:00:00Z'))).toBe('2026-11-21');
    expect(newSpendKey()).toMatch(/^rs:[0-9a-f]{24}$/);
    expect(newSpendKey()).not.toBe(newSpendKey());
  });
});
