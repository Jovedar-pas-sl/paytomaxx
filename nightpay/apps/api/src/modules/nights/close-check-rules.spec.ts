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
    expect(s.items[3]!.label).toContain('Devolución de 10,00 €');
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
    expect(s.items[0]!.label).toBe('Barra: cobrando 50,00 € ahora mismo');
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
    expect(s.items[1]!.label).toContain('Sala: 3 ventas (120,00 €) sin cuadrar');
    expect(s.items[1]!.label).toContain('sin señal desde hace 1 h');
    expect(s.link).toBe('terminals');
  });
});

describe('3 · saldo devuelto pendiente', () => {
  it('devolución a la tarjeta a medias y cliente esperando su saldo → aviso', () => {
    const s = saldoStep(
      [{ id: 'wp', amountCents: 3000, createdAt: ago(10), shortCode: 'K7Q' }],
      [{ id: 'w', balanceCents: 1500, shortCode: null }],
    );
    expect(s).toMatchObject({ status: 'warn', count: 2, link: 'wallets' });
    expect(s.items[0]!.label).toContain('código K7Q');
  });

  it('nada por devolver → listo', () => {
    expect(saldoStep([], []).status).toBe('ok');
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
    expect(s.detail).toContain('debería haber 80,00 €');
    expect(s.count).toBe(3);
    expect(s.items.map((i) => i.amountCents)).toEqual([-3000, -9000]);
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
    expect(s.detail).toBe('Queda 1 persona por pagar: 90,00 €.');
    expect(s.title).toBe('Pagar al personal');
    expect(s.items[0]!.label).toBe('Lola: Págale 90,00 €');
    expect(s.items[1]!.label).toBe('Ana: Nada que pagar ya · pagado esta noche 40,00 €');
  });

  it('con días de espera: lo de esta noche queda en espera y no avisa', () => {
    const chicas = [chicaPay(balance({ unpaidCents: 9000, heldCents: 9000, earnedTonightCents: 9000, debtCents: 500 }))];
    const s = chicasStep(chicas, 7);
    expect(s.status).toBe('ok');
    expect(s.detail).toContain('90,00 € siguen en espera: se pagan pasados 7 días');
    expect(s.items[0]!.label).toBe('Lola: Nada que pagar ya · 90,00 € en espera · debe 5,00 € por devoluciones');
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
    expect(steps[6]!.title).toBe('Congelar el Z');
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
