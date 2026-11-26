import { describe, it, expect, vi } from 'vitest';
import {
  chargedAttemptTip,
  creatorTipConfirmable,
  defaultTipGoesTo,
  maxTipCents,
  readChargedTip,
  settleChargedTip,
  tipChoiceAllowed,
  tipDestinationAllowed,
  tipGoesToStaff,
  tipOptionsFor,
  tipPresetsFor,
} from './tip';

describe('propina que pone quien crea el cobro', () => {
  it('solo vale con Redsys en un cobro con QR: el banco dice cuánta cobró', () => {
    expect(creatorTipConfirmable({ provider: 'REDSYS', isPosExternal: false, isWalletTopUp: false })).toBe(true);
  });

  it('por datáfono, en otras pasarelas o en recargas de saldo no vale (sería dinero inventado)', () => {
    expect(creatorTipConfirmable({ provider: 'REDSYS', isPosExternal: true, isWalletTopUp: false })).toBe(false);
    expect(creatorTipConfirmable({ provider: 'REDSYS', isPosExternal: false, isWalletTopUp: true })).toBe(false);
    expect(creatorTipConfirmable({ provider: 'PAYTEF', isPosExternal: false, isWalletTopUp: false })).toBe(false);
    expect(creatorTipConfirmable({ provider: 'PEANPE', isPosExternal: false, isWalletTopUp: false })).toBe(false);
    expect(creatorTipConfirmable({ provider: null, isPosExternal: false, isWalletTopUp: false })).toBe(false);
  });

  it('como mucho el importe del cobro y nunca más de 500 €', () => {
    expect(maxTipCents(2_000)).toBe(2_000);
    expect(maxTipCents(100_000)).toBe(50_000);
    expect(maxTipCents(0)).toBe(0);
  });

  it('la chica solo la da para ella o para el local', () => {
    expect(tipDestinationAllowed('OPERATOR', 'operator')).toBe(true);
    expect(tipDestinationAllowed('OPERATOR', 'venue')).toBe(true);
    expect(tipDestinationAllowed('OPERATOR', null)).toBe(true);
    expect(tipDestinationAllowed('OPERATOR', 'beneficiary')).toBe(false);
    expect(tipDestinationAllowed('OPERATOR', 'shared')).toBe(false);
  });

  it('el local (dueño, encargado, camarero) puede darla a otra persona', () => {
    expect(tipDestinationAllowed('OWNER', 'beneficiary')).toBe(true);
    expect(tipDestinationAllowed('WAITER', 'beneficiary')).toBe(true);
  });
});

describe('tipPresetsFor — propinas que crecen con el importe', () => {
  it('hasta 40 €: +2 € y +5 €', () => {
    expect(tipPresetsFor(1_500)).toEqual([
      { cents: 200, percent: null },
      { cents: 500, percent: null },
    ]);
    expect(tipPresetsFor(4_000)).toEqual([
      { cents: 200, percent: null },
      { cents: 500, percent: null },
    ]);
  });

  it('más de 40 €: 10 % y 15 %, redondeados a euros enteros', () => {
    expect(tipPresetsFor(6_500)).toEqual([
      { cents: 700, percent: 10 },
      { cents: 1_000, percent: 15 },
    ]);
    expect(tipPresetsFor(4_100)).toEqual([
      { cents: 400, percent: 10 },
      { cents: 600, percent: 15 },
    ]);
    expect(tipPresetsFor(20_000)).toEqual([
      { cents: 2_000, percent: 10 },
      { cents: 3_000, percent: 15 },
    ]);
  });

  it('nunca por encima del máximo: importes pequeños o enormes se quedan sin las que no caben', () => {
    // 3 €: como mucho 3 € de propina → +2 € sí, +5 € no.
    expect(tipPresetsFor(300)).toEqual([{ cents: 200, percent: null }]);
    // 4.000 €: el 15 % (600 €) pasa de 500 €.
    expect(tipPresetsFor(400_000)).toEqual([{ cents: 40_000, percent: 10 }]);
    expect(tipPresetsFor(0)).toEqual([]);
  });
});

describe('tipOptionsFor', () => {
  it('sin propina y las dos del importe', () => {
    expect(tipOptionsFor({ amountCents: 2_000, tipCents: 0, allowTip: true })).toEqual([0, 200, 500]);
    expect(tipOptionsFor({ amountCents: 10_000, tipCents: 0, allowTip: true })).toEqual([0, 1_000, 1_500]);
  });

  it('incluye la propina que ya traía el cobro', () => {
    expect(tipOptionsFor({ amountCents: 2_000, tipCents: 300, allowTip: true })).toEqual([0, 200, 300, 500]);
  });

  it('sin propina cuando no se puede (recarga de wallet u otra pasarela)', () => {
    expect(tipOptionsFor({ amountCents: 2_000, tipCents: 500, allowTip: false })).toEqual([0]);
  });
});

describe('tipChoiceAllowed — lo que acepta el servidor al pulsar «Pagar»', () => {
  const p = { amountCents: 6_500, tipCents: 0, allowTip: true };

  it('sin propina siempre vale', () => {
    expect(tipChoiceAllowed(p, 0)).toBe(true);
    expect(tipChoiceAllowed({ ...p, allowTip: false }, 0)).toBe(true);
  });

  it('las propinas sugeridas (10 % y 15 %) valen', () => {
    for (const c of tipOptionsFor(p)) expect(tipChoiceAllowed(p, c)).toBe(true);
  });

  it('«Otra»: cualquier importe hasta el máximo; por encima, no', () => {
    expect(tipChoiceAllowed(p, 300)).toBe(true);
    expect(tipChoiceAllowed(p, 1_234)).toBe(true);
    expect(tipChoiceAllowed(p, maxTipCents(6_500))).toBe(true);
    expect(tipChoiceAllowed(p, maxTipCents(6_500) + 1)).toBe(false);
    expect(tipChoiceAllowed({ amountCents: 200_000, tipCents: 0, allowTip: true }, 50_001)).toBe(false);
  });

  it('negativa, con decimales o donde no se puede dejar propina → no', () => {
    expect(tipChoiceAllowed(p, -100)).toBe(false);
    expect(tipChoiceAllowed(p, 150.5)).toBe(false);
    expect(tipChoiceAllowed(p, Number.NaN)).toBe(false);
    expect(tipChoiceAllowed({ ...p, allowTip: false }, 500)).toBe(false);
  });

  it('«Va entera para el personal» solo si de verdad va a una persona', () => {
    expect(tipGoesToStaff({ tipGoesTo: null, creatorRole: 'OPERATOR' })).toBe(true);
    expect(tipGoesToStaff({ tipGoesTo: 'beneficiary', creatorRole: 'OWNER' })).toBe(true);
    // Cobro del camarero o del encargado: la propina es del local.
    expect(tipGoesToStaff({ tipGoesTo: null, creatorRole: 'MANAGER' })).toBe(false);
    expect(tipGoesToStaff({ tipGoesTo: 'venue', creatorRole: 'OPERATOR' })).toBe(false);
    expect(tipGoesToStaff({ tipGoesTo: 'shared', creatorRole: 'OPERATOR' })).toBe(false);
    expect(tipGoesToStaff({ tipGoesTo: null, creatorRole: null })).toBe(false);
    // El encargado o recepción cobran el servicio a nombre de una compañera: es suya.
    expect(tipGoesToStaff({ tipGoesTo: 'operator', creatorRole: 'MANAGER', served: true })).toBe(true);
    expect(tipGoesToStaff({ tipGoesTo: 'operator', creatorRole: 'MANAGER' })).toBe(false);
  });

  it('la propina que ya traía el cobro sigue valiendo', () => {
    expect(tipChoiceAllowed({ amountCents: 1_000, tipCents: 1_000, allowTip: true }, 1_000)).toBe(true);
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
