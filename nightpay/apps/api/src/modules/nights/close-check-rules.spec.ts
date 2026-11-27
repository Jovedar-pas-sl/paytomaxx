import { describe, it, expect } from 'vitest';
import type { NightCash, NightChicaPay } from '@nightpay/contracts';
import type { Incident } from '../incidents/incident-rules';
import {
  buildCloseSteps,
  chicaPay,
  chicasStep,
  cobrosStep,
  datafonosStep,
  efectivoStep,
  incidenciasStep,
  saldoStep,
  worst,
  type ChicaBalanceRow,
  type UnresolvedPaymentRow,
} from './close-check-rules';

const NOW = new Date('2026-10-14T01:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const NO_CASH: NightCash = {
  openingFloatCents: null,
  cashInCents: 0,
  walletCashPayoutsCount: 0,
  walletCashPayoutsCents: 0,
  chicaCashPayoutsCount: 0,
  chicaCashPayoutsCents: 0,
  cashOutCents: 0,
  expectedCents: 0,
};

function payment(o: Partial<UnresolvedPaymentRow> = {}): UnresolvedPaymentRow {
  return {
    id: 'p-1',
    status: 'AUTHORIZING',
    amountCents: 2500,
    captureMethod: 'QR',
    createdAt: ago(30),
    updatedAt: ago(30),
    ...o,
  };
}

function balance(o: Partial<ChicaBalanceRow> = {}): ChicaBalanceRow {
  return {
    operatorId: 'op-1',
    name: 'Lola',
    payoutMethod: 'MANUAL_CASH',
    payoutAddress: null,
    payoutLabel: null,
    unpaidCents: 0,
    heldCents: 0,
    earnedTonightCents: 0,
    paidTonightCents: 0,
    paidTonightCount: 0,
    debtCents: 0,
    ...o,
  };
}

describe('5 · pagar al personal: la cuenta va tapada', () => {
  it('la tapada guardada aparte; una antigua en claro, tapada al vuelo; nunca entera', () => {
    const sealed = chicaPay(balance({ payoutMethod: 'SEPA_IBAN', payoutAddress: 'pa1:x:y:z', payoutAddressMasked: 'ES91 •••• •••• 1332' }));
    expect(sealed.payoutAddressMasked).toBe('ES91 •••• •••• 1332');
    expect(sealed).not.toHaveProperty('payoutAddress');
    const legacy = chicaPay(balance({ payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES9121000418450200051332' }));
    expect(legacy.payoutAddressMasked).toBe('ES91 •••• •••• 1332');
    expect(JSON.stringify(legacy)).not.toContain('ES9121000418450200051332');
  });

  it('la espera de 48 h tras cambiar la cuenta, solo si aún no ha pasado', () => {
    const until = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(chicaPay(balance({ payoutHoldUntil: until }), NOW).payoutHoldUntil).toBe(until.toISOString());
    expect(chicaPay(balance({ payoutHoldUntil: new Date(NOW.getTime() - 1000) }), NOW).payoutHoldUntil).toBeNull();
  });
});

describe('1 · cobros sin terminar', () => {
  it('sin nada pendiente → listo', () => {
    const s = cobrosStep([], [], NOW);
    expect(s).toMatchObject({ key: 'cobros', status: 'ok', count: 0, link: 'payments' });
  });

  it('un cliente pagando hace menos de 15 min → bloquea («espera o resuélvelo»)', () => {
    const s = cobrosStep([payment({ updatedAt: ago(5) })], [], NOW);
    expect(s.status).toBe('block');
    expect(s.detail).toMatch(/espera o resuélvelo/);
    expect(s.items[0]).toMatchObject({ status: 'block', amountCents: 2500 });
    expect(s.items[0]!.label).toContain('el cliente está pagando');
  });

  it('con bitcoin: «pagando con bitcoin» y, atascado, su factura en BTCPay (sin hablar del banco)', () => {
    const s = cobrosStep([payment({ id: 'x', updatedAt: ago(5), provider: 'BTCPAY' }), payment({ id: 'y', updatedAt: ago(20), provider: 'BTCPAY' })], [], NOW);
    expect(s.items[0]!.label).toContain('el cliente está pagando con bitcoin');
    expect(s.items[1]!.label).toContain('mira su factura en BTCPay');
    expect(s.items.map((i) => i.label).join(' ')).not.toMatch(/banco|BBVA/);
  });

  it('atascado (15 min o más), sin confirmar por el banco, datáfono o devolución pendiente → aviso', () => {
    const s = cobrosStep(
      [
        payment({ id: 'a', updatedAt: ago(15) }),
        payment({ id: 'b', status: 'ORPHAN' }),
        payment({ id: 'c', status: 'CREATED', captureMethod: 'POS_EXTERNAL', updatedAt: ago(1) }),
      ],
      [{ id: 'r', amountCents: 1000, createdAt: ago(40) }],
      NOW,
    );
    expect(s.status).toBe('warn');
    expect(s.count).toBe(4);
    expect(s.items.map((i) => i.status)).toEqual(['warn', 'warn', 'warn', 'warn']);
    expect(s.items[0]!.label).toContain('atascado');
    expect(s.items[1]!.label).toContain('búscalo en BBVA');
    expect(s.items[2]!.label).toContain('datáfono sin confirmar');
    expect(s.items[3]!.label).toContain('Devolución de 10,00\u00a0€');
  });
});

describe('2 · datáfonos', () => {
  it('sin datáfonos vinculados → listo, y lo dice', () => {
    expect(datafonosStep([], [], 0, NOW)).toMatchObject({ status: 'ok', detail: expect.stringContaining('No hay datáfonos') });
  });

  it('un datáfono cobrando ahora (sin resultado, < 15 min) → bloquea', () => {
    const s = datafonosStep(
      [{ id: 'p', amountCents: 5000, status: 'CREATED', startedAt: ago(2), terminalLabel: 'Barra' }],
      [],
      1,
      NOW,
    );
    expect(s.status).toBe('block');
    expect(s.items[0]!.label).toBe('Barra: cobrando 50,00\u00a0€ ahora mismo');
  });

  it('resultado sin mandar hace rato o ventas sin cuadrar → aviso', () => {
    const s = datafonosStep(
      [{ id: 'p', amountCents: 5000, status: 'EXPIRED', startedAt: ago(40), terminalLabel: null }],
      [
        {
          terminalId: 't-1',
          label: 'Sala',
          sales: 3,
          cents: 12_000,
          lastSaleAt: ago(10),
          lastReportAt: null,
          lastSeenAt: ago(90),
        },
      ],
      2,
      NOW,
    );
    expect(s.status).toBe('warn');
    expect(s.items[0]!.label).toContain('no mandó el resultado');
    expect(s.items[1]!.label).toContain('Sala: 3 ventas (120,00\u00a0€) sin cuadrar');
    expect(s.items[1]!.label).toContain('sin señal desde hace 1 h');
    expect(s.link).toBe('terminals');
  });
});

describe('3 · saldo devuelto pendiente', () => {
  it('devolución a la tarjeta a medias y cliente esperando su saldo → aviso', () => {
    const s = saldoStep(
      [{ id: 'wp', amountCents: 3000, createdAt: ago(10), shortCode: 'K7Q4M2' }],
      [{ id: 'w', balanceCents: 1500, shortCode: null }],
    );
    expect(s).toMatchObject({ status: 'warn', count: 2, link: 'wallets' });
    expect(s.items[0]!.label).toContain('código K7Q-4M2');
  });

  it('dice dónde se termina en el panel («Clientes → Saldos»), que son de antes de la nueva regla, y el código con guion', () => {
    const s = saldoStep(
      [{ id: 'wp', amountCents: 3000, createdAt: ago(10), shortCode: 'K7Q4M2' }],
      [{ id: 'w', balanceCents: 2900, shortCode: 'UYSJ5G' }],
    );
    expect(s.detail).toBe(
      'Son de antes de la nueva regla (el saldo ya no se devuelve). Termínalas antes de contar la caja: en efectivo cuentan en el arqueo; a la tarjeta, en Clientes → Saldos.',
    );
    expect(s.items.map((i) => i.label)).toEqual([
      'Devolución a la tarjeta a medias: 30,00\u00a0€ · código K7Q-4M2. Termínala en Clientes → Saldos',
      'Devolución pedida antes de la nueva regla: 29,00\u00a0€ · código UYS-J5G. Termínala en Clientes → Saldos',
    ]);
    for (const text of [s.detail, ...s.items.map((i) => i.label)]) expect(text).not.toMatch(/wallet/i);
  });

  it('nada pendiente → listo', () => {
    const s = saldoStep([], []);
    expect(s.status).toBe('ok');
    expect(s.detail).toBe('No hay devoluciones de saldo pendientes.');
  });
});

describe('4 · efectivo (sin contar aún)', () => {
  it('sin efectivo ni fondo → no hace falta contar', () => {
    expect(efectivoStep(NO_CASH)).toMatchObject({ status: 'ok', count: 0, items: [] });
  });

  it('con efectivo que salió → bloquea hasta contar, y lista las salidas', () => {
    const s = efectivoStep({
      ...NO_CASH,
      openingFloatCents: 20_000,
      walletCashPayoutsCount: 1,
      walletCashPayoutsCents: 3000,
      chicaCashPayoutsCount: 2,
      chicaCashPayoutsCents: 9000,
      cashOutCents: 12_000,
      expectedCents: 8000,
    });
    expect(s.status).toBe('block');
    // A ciegas: el texto no dice lo que debería haber.
    expect(s.detail).toContain('escribe lo contado');
    expect(s.detail).not.toContain('80,00');
    expect(s.count).toBe(3);
    expect(s.items.map((i) => i.amountCents)).toEqual([-3000, -9000]);
  });

  it('los pagos a los camareros, en su línea (no como pagos a las chicas)', () => {
    const s = efectivoStep({
      ...NO_CASH,
      openingFloatCents: 20_000,
      chicaCashPayoutsCount: 1,
      chicaCashPayoutsCents: 751,
      camareroCashPayoutsCount: 1,
      camareroCashPayoutsCents: 750,
      cashOutCents: 1501,
      expectedCents: 18_499,
    });
    expect(s.count).toBe(2);
    expect(s.items.map((i) => [i.id, i.label, i.amountCents])).toEqual([
      ['chica-cash', 'Pagos a las chicas en efectivo: 1 pago', -751],
      ['camarero-cash', 'Pagos a los camareros en efectivo: 1 pago', -750],
    ]);
  });
});

describe('5 · pagar a las chicas', () => {
  it('lo que se le paga = lo ya liberado menos la deuda (como el botón Pagar)', () => {
    expect(chicaPay(balance({ unpaidCents: 10_000, debtCents: 2000 })).toPayCents).toBe(8000);
    expect(chicaPay(balance({ unpaidCents: 10_000, heldCents: 10_000 })).toPayCents).toBe(0);
    // La deuda mayor que lo liberado: nada que pagar (no un pago negativo).
    expect(chicaPay(balance({ unpaidCents: 1000, debtCents: 3000 })).toPayCents).toBe(0);
  });

  it('se paga al cierre (0 días): quien tiene algo → aviso «Págale X €»', () => {
    const chicas = [
      chicaPay(balance({ unpaidCents: 9000, earnedTonightCents: 9000 })),
      chicaPay(balance({ operatorId: 'op-2', name: 'Ana', paidTonightCents: 4000, paidTonightCount: 1 })),
    ];
    const s = chicasStep(chicas, 0);
    expect(s).toMatchObject({ status: 'warn', count: 1, link: 'operators' });
    expect(s.detail).toBe('Queda 1 persona por pagar: 90,00\u00a0€.');
    expect(s.title).toBe('Pagar al personal');
    expect(s.items[0]!.label).toBe('Lola: Págale 90,00\u00a0€');
    expect(s.items[1]!.label).toBe('Ana: Nada que pagar ya · pagado esta noche 40,00\u00a0€');
  });

  it('con días de espera: lo de esta noche queda en espera y no avisa', () => {
    const chicas = [chicaPay(balance({ unpaidCents: 9000, heldCents: 9000, earnedTonightCents: 9000, debtCents: 500 }))];
    const s = chicasStep(chicas, 7);
    expect(s.status).toBe('ok');
    expect(s.detail).toContain('90,00\u00a0€ siguen en espera: se pagan pasados 7 días');
    expect(s.items[0]!.label).toBe('Lola: Nada que pagar ya · 90,00\u00a0€ en espera · debe 5,00\u00a0€ por devoluciones');
  });

  it('sin chicas con nada → listo', () => {
    expect(chicasStep([], 0)).toMatchObject({ status: 'ok', detail: 'Nadie del personal tiene nada que cobrar.' });
  });
});

describe('6 · incidencias abiertas', () => {
  const incident = (kind: Incident['kind'], refId: string, title: string): Incident => ({
    kind,
    refId,
    title,
    detail: '',
    occurredAt: NOW.toISOString(),
    amountCents: null,
    paymentId: null,
    ackable: false,
  });

  it('cuenta y agrupa por tipo', () => {
    const s = incidenciasStep([
      incident('stuck_payment', 'a', 'Cobro atascado esperando al banco'),
      incident('stuck_payment', 'b', 'Cobro sin confirmar por el banco'),
      incident('bank_mismatch', 'c', 'Importe distinto en el banco'),
    ]);
    expect(s).toMatchObject({ status: 'warn', count: 3, link: 'incidents' });
    expect(s.items.map((i) => i.label)).toEqual(['Cobro atascado esperando al banco (×2)', 'Importe distinto en el banco']);
  });

  it('sin incidencias → listo', () => {
    expect(incidenciasStep([])).toMatchObject({ status: 'ok', count: 0 });
  });
});

describe('los siete pasos', () => {
  it('en orden, y el último es congelar el Z', () => {
    const steps = buildCloseSteps({
      now: NOW,
      holdDays: 0,
      payments: [],
      refunds: [],
      posStarted: [],
      posUnreconciled: [],
      pairedDevices: 0,
      walletPayouts: [],
      walletsToClose: [],
      cash: NO_CASH,
      chicas: [] as NightChicaPay[],
      incidents: [],
    });
    expect(steps.map((s) => s.key)).toEqual(['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z']);
    expect(steps.every((s) => s.status === 'ok')).toBe(true);
    expect(steps[6]!.title).toBe('Informe Z');
    expect(steps[6]!.detail).toBe('Al cerrar, el informe Z ya no cambia: lo que llegue después irá como ajuste en el de la noche siguiente.');
  });

  it('el peor estado manda', () => {
    expect(worst([{ status: 'ok' }, { status: 'warn' }])).toBe('warn');
    expect(worst([{ status: 'warn' }, { status: 'block' }])).toBe('block');
    expect(worst([])).toBe('ok');
  });
});

describe('1 · cobros sin terminar — recargas del datáfono (pagos #9)', () => {
  it('recarga a medio cobrar en el lector y recarga sin la prueba de Paytef: aviso (no bloquea) con su texto', () => {
    const s = cobrosStep(
      [
        payment({ id: 'm', status: 'CREATED', captureMethod: 'WALLET_TOPUP', updatedAt: ago(1) }),
        payment({ id: 'u', status: 'AUTHORIZING', captureMethod: 'WALLET_TOPUP', deviceSale: true, updatedAt: ago(2) }),
      ],
      [],
      NOW,
    );
    expect(s.items.map((i) => i.status)).toEqual(['warn', 'warn']);
    expect(s.items[0]!.label).toContain('recarga a medio cobrar en el datáfono');
    expect(s.items[1]!.label).toContain('sin comprobar con Paytef');
  });
});
