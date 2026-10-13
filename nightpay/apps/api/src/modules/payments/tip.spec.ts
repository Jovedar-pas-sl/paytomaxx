import { describe, it, expect, vi } from 'vitest';
import {
  chargedAttemptTip,
  defaultTipGoesTo,
  readChargedTip,
  settleChargedTip,
  tipOptionsFor,
} from './tip';

describe('tipOptionsFor', () => {
  it('ofrece sin propina, 5 € y 10 €', () => {
    expect(tipOptionsFor({ tipCents: 0, allowTip: true })).toEqual([0, 500, 1000]);
  });

  it('incluye la propina que ya traía el cobro', () => {
    expect(tipOptionsFor({ tipCents: 300, allowTip: true })).toEqual([0, 300, 500, 1000]);
  });

  it('sin propina cuando no se puede (recarga de wallet u otra pasarela)', () => {
    expect(tipOptionsFor({ tipCents: 500, allowTip: false })).toEqual([0]);
  });
});

describe('settleChargedTip', () => {
  it('con propina: se puede devolver importe + propina y va a la chica que cobró', () => {
    expect(
      settleChargedTip({ amountCents: 10_000, tipCents: 500, tipGoesTo: null, creatorRole: 'OPERATOR' }),
    ).toEqual({ tipCents: 500, availableAmountCents: 10_500, tipGoesTo: 'operator' });
  });

  it('cobro del camarero: la propina es del local', () => {
    expect(defaultTipGoesTo('MANAGER')).toBe('venue');
    expect(
      settleChargedTip({ amountCents: 2_000, tipCents: 500, tipGoesTo: null, creatorRole: 'MANAGER' }).tipGoesTo,
    ).toBe('venue');
  });

  it('respeta un destino ya fijado por el local', () => {
    expect(
      settleChargedTip({ amountCents: 2_000, tipCents: 500, tipGoesTo: 'beneficiary', creatorRole: 'OWNER' })
        .tipGoesTo,
    ).toBe('beneficiary');
  });

  it('sin propina: limpia el destino y deja solo el importe', () => {
    expect(
      settleChargedTip({ amountCents: 10_000, tipCents: 0, tipGoesTo: 'operator', creatorRole: 'OPERATOR' }),
    ).toEqual({ tipCents: 0, availableAmountCents: 10_000, tipGoesTo: null });
  });
});

describe('chargedAttemptTip — resolver a mano', () => {
  const attempts = [
    { providerTxId: '1111AAAA2222', tipCents: 500 },
    { providerTxId: '3333BBBB4444', tipCents: 0 },
  ];

  it('con el pedido del portal del banco → la propina de ese intento', () => {
    expect(chargedAttemptTip(attempts, '3333BBBB4444')).toEqual({ ok: true, tipCents: 0 });
  });

  it('pedido que no es de este cobro → error', () => {
    expect(chargedAttemptTip(attempts, '9999')).toEqual({ ok: false, reason: 'unknown-order' });
  });

  it('intentos con propinas distintas y sin pedido → hay que decir cuál', () => {
    expect(chargedAttemptTip(attempts)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('un solo intento → su propina', () => {
    expect(chargedAttemptTip([attempts[0]!])).toEqual({ ok: true, tipCents: 500 });
  });

  it('intentos antiguos sin propina registrada → no se toca', () => {
    expect(chargedAttemptTip([{ providerTxId: 'x', tipCents: null }])).toEqual({ ok: true, tipCents: null });
    expect(chargedAttemptTip([])).toEqual({ ok: true, tipCents: null });
  });
});

describe('readChargedTip', () => {
  const event = { provider: 'REDSYS', providerTxId: '1111AAAA2222' };

  it('propina del intento cobrado y rol de quien creó el cobro', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ tipCents: 500, creatorRole: 'OPERATOR' }]) };
    await expect(readChargedTip(tx as never, 'pay-1', event)).resolves.toEqual({
      tipCents: 500,
      creatorRole: 'OPERATOR',
    });
  });

  it('intento anterior a la Fase 1B (sin propina registrada) → null, no se toca', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ tipCents: null, creatorRole: 'OPERATOR' }]) };
    await expect(readChargedTip(tx as never, 'pay-1', event)).resolves.toBeNull();
  });

  it('pedido que no es un intento de este cobro → null', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    await expect(readChargedTip(tx as never, 'pay-1', event)).resolves.toBeNull();
  });
});
