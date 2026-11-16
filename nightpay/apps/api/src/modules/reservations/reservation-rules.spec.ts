import { describe, expect, it } from 'vitest';
import { reservationDepositCents } from '@nightpay/contracts';
import {
  applyPaid,
  arrivalProblem,
  arrivalSaleCents,
  bookableNightProblem,
  clientChangeBlocker,
  clientChangeProblem,
  commissionDue,
  guestTokenFrom,
  itemsLeft,
  moneyParts,
  nightEnd,
  nightOf,
  nightStart,
  noShowOutcome,
  noShowProblem,
  payAmount,
  payableKinds,
  promoterCommissionCents,
} from './reservation-rules';
import { isReservationPaymentKey, reservationPaymentKey } from './reservation-payment-key';

const pkg = { priceCents: 30000, depositCents: 9000 };

describe('la señal (30 %) y el resto', () => {
  it('la señal es el 30 % en céntimos enteros y el resto el 70 %', () => {
    expect(moneyParts(30000)).toEqual({ priceCents: 30000, depositCents: 9000, restCents: 21000 });
    expect(reservationDepositCents(12345)).toBe(3704);
    expect(moneyParts(12345).restCents).toBe(8641);
  });

  it('sin pagar: señal o todo; con la señal: solo el resto; pagado: nada', () => {
    expect(payableKinds({ ...pkg, status: 'PENDING', paidCents: 0 })).toEqual(['DEPOSIT', 'FULL']);
    expect(payableKinds({ ...pkg, status: 'DEPOSIT_PAID', paidCents: 9000 })).toEqual(['REST']);
    expect(payableKinds({ ...pkg, status: 'PAID', paidCents: 30000 })).toEqual([]);
    expect(payAmount({ ...pkg, status: 'PENDING', paidCents: 0 }, 'DEPOSIT')).toBe(9000);
    expect(payAmount({ ...pkg, status: 'PENDING', paidCents: 0 }, 'FULL')).toBe(30000);
    expect(payAmount({ ...pkg, status: 'DEPOSIT_PAID', paidCents: 9000 }, 'REST')).toBe(21000);
    expect(payAmount({ ...pkg, status: 'PENDING', paidCents: 0 }, 'REST')).toBeNull();
  });

  it('un pago del banco suma: señal → Señal pagada; resto → Pagado; de más o cerrada → incidencia', () => {
    expect(applyPaid({ ...pkg, status: 'PENDING', paidCents: 0 }, 9000)).toEqual({ ok: true, paidCents: 9000, status: 'DEPOSIT_PAID', fullyPaid: false });
    expect(applyPaid({ ...pkg, status: 'DEPOSIT_PAID', paidCents: 9000 }, 21000)).toEqual({ ok: true, paidCents: 30000, status: 'PAID', fullyPaid: true });
    expect(applyPaid({ ...pkg, status: 'PENDING', paidCents: 0 }, 30000)).toMatchObject({ ok: true, status: 'PAID', fullyPaid: true });
    // La señal pagada dos veces (dos pestañas): la segunda no cabe.
    expect(applyPaid({ ...pkg, status: 'PAID', paidCents: 30000 }, 9000)).toEqual({ ok: false, reason: 'closed' });
    expect(applyPaid({ ...pkg, status: 'DEPOSIT_PAID', paidCents: 9000 }, 30000)).toEqual({ ok: false, reason: 'overpaid' });
    expect(applyPaid({ ...pkg, status: 'CANCELED', paidCents: 0 }, 9000)).toEqual({ ok: false, reason: 'closed' });
  });

  it('la clave de los pagos de una reserva se reconoce (sin saldo a la vista ni bitcoin)', () => {
    const key = reservationPaymentKey('0f0e0d0c-0000-4000-8000-000000000001', 'DEPOSIT', 1);
    expect(key).toBe('resv:0f0e0d0c-0000-4000-8000-000000000001:DEPOSIT:1');
    expect(isReservationPaymentKey(key)).toBe(true);
    expect(isReservationPaymentKey('wcasa:abc')).toBe(false);
    expect(isReservationPaymentKey(null)).toBe(false);
  });
});

describe('la noche y las 48 h', () => {
  // 2026-11-20 a las 12:00 de Madrid (UTC+1).
  const now = new Date('2026-11-20T11:00:00Z');

  it('la noche va de las 20:00 a las 08:00 de Madrid; antes de las 08:00 aún es la de ayer', () => {
    expect(nightStart('2026-11-21').toISOString()).toBe('2026-11-21T19:00:00.000Z');
    expect(nightEnd('2026-11-21').toISOString()).toBe('2026-11-22T07:00:00.000Z');
    expect(nightOf(new Date('2026-11-21T06:59:00Z'))).toBe('2026-11-20');
    expect(nightOf(new Date('2026-11-21T07:00:00Z'))).toBe('2026-11-21');
    // Verano (UTC+2).
    expect(nightStart('2027-07-10').toISOString()).toBe('2027-07-10T18:00:00.000Z');
  });

  it('se reserva desde esta noche y hasta 120 días; fechas raras no', () => {
    expect(bookableNightProblem('2026-11-20', now)).toBeNull();
    expect(bookableNightProblem('2026-11-19', now)).toBe('Esa noche ya ha pasado');
    expect(bookableNightProblem('2027-03-20', now)).toBeNull();
    expect(bookableNightProblem('2027-03-21', now)).toBe('Se reserva como mucho con 120 días');
    expect(bookableNightProblem('2026-02-31', now)).toBe('Esa fecha no vale');
  });

  it('cambiar la fecha: con la señal pagada, una sola vez y avisando con 48 h', () => {
    const r = { status: 'DEPOSIT_PAID', nightDate: '2026-11-25', dateChangedAt: null };
    expect(clientChangeProblem(r, '2026-11-28', now)).toBeNull();
    // Justo en el límite (48 h antes de las 20:00 de esa noche) sí; un minuto después, no.
    const limit = new Date(nightStart('2026-11-25').getTime() - 48 * 3600_000);
    expect(clientChangeBlocker(r, limit)).toBeNull();
    expect(clientChangeBlocker(r, new Date(limit.getTime() + 60_000))).toBe('La fecha se cambia avisando con 48 horas');
    // Una sola vez.
    expect(clientChangeProblem({ ...r, dateChangedAt: new Date() }, '2026-11-28', now)).toBe('La fecha solo se puede cambiar una vez');
    // Sin pagar o ya llegada: no.
    expect(clientChangeBlocker({ ...r, status: 'PENDING' }, now)).toBe('Esta reserva ya no se puede cambiar');
    expect(clientChangeBlocker({ ...r, status: 'ARRIVED' }, now)).toBe('Esta reserva ya no se puede cambiar');
    expect(clientChangeProblem(r, '2026-11-25', now)).toBe('Elige otra noche');
    expect(clientChangeProblem(r, '2026-11-01', now)).toBe('Esa noche ya ha pasado');
  });
});

describe('llegada, «No vino» y lo que pasa a venta', () => {
  const r = { ...pkg, nightDate: '2026-11-21', creditCents: 0 };
  const during = new Date('2026-11-21T23:00:00Z');
  const after = new Date('2026-11-22T07:00:00Z');

  it('la llegada: pagado entero y en su noche', () => {
    expect(arrivalProblem({ ...r, status: 'PAID', paidCents: 30000 }, during)).toBeNull();
    expect(arrivalProblem({ ...r, status: 'DEPOSIT_PAID', paidCents: 9000 }, during)).toBe('Falta por pagar el resto');
    expect(arrivalProblem({ ...r, status: 'PAID', paidCents: 30000 }, after)).toBe('Esta reserva es de la noche del 2026-11-21');
    expect(arrivalProblem({ ...r, status: 'PENDING', paidCents: 0 }, during)).toBe('Esta reserva no está pagada');
  });

  it('al llegar pasa a venta el paquete menos el importe para consumir (que queda de saldo)', () => {
    expect(arrivalSaleCents({ priceCents: 30000, creditCents: 0 })).toBe(30000);
    expect(arrivalSaleCents({ priceCents: 30000, creditCents: 25000 })).toBe(5000);
    expect(arrivalSaleCents({ priceCents: 30000, creditCents: 30000 })).toBe(0);
  });

  it('«No vino» solo cuando acaba su noche (la reserva se guarda toda la noche)', () => {
    expect(noShowProblem({ status: 'PAID', nightDate: '2026-11-21' }, during)).toBe('La reserva se guarda toda la noche: márcala cuando acabe');
    expect(noShowProblem({ status: 'PAID', nightDate: '2026-11-21' }, after)).toBeNull();
    expect(noShowProblem({ status: 'PENDING', nightDate: '2026-11-21' }, after)).toBe('Esta reserva no está pendiente de llegar');
  });

  it('no-show con el 100 % pagado: pierde la señal y el 70 % queda de saldo; con la señal: la pierde', () => {
    expect(noShowOutcome({ depositCents: 9000, paidCents: 30000 })).toEqual({ lostCents: 9000, leftCents: 21000 });
    expect(noShowOutcome({ depositCents: 9000, paidCents: 9000 })).toEqual({ lostCents: 9000, leftCents: 0 });
  });

  it('lo que queda de cada cosa del paquete', () => {
    const items = [
      { name: 'Botella', qty: 2 },
      { name: 'Entrada', qty: 6 },
    ];
    expect(itemsLeft(items, [{ name: 'Botella', qty: 1 }, { name: 'Botella', qty: 1 }, { name: 'Entrada', qty: 2 }])).toEqual([
      { name: 'Botella', qty: 2, left: 0 },
      { name: 'Entrada', qty: 6, left: 4 },
    ]);
  });
});

describe('la comisión del RRPP', () => {
  it('su % del paquete, en céntimos enteros', () => {
    expect(promoterCommissionCents(30000, 1000)).toBe(3000);
    expect(promoterCommissionCents(12345, 750)).toBe(926);
  });

  it('solo con el paquete pagado entero, una vez y si lo vendió un RRPP', () => {
    const base = { priceCents: 30000, promoterId: 'p1', commissionEarnedAt: null };
    expect(commissionDue({ ...base, paidCents: 9000 })).toBe(false);
    expect(commissionDue({ ...base, paidCents: 30000 })).toBe(true);
    expect(commissionDue({ ...base, paidCents: 30000, commissionEarnedAt: new Date() })).toBe(false);
    expect(commissionDue({ ...base, paidCents: 30000, promoterId: null })).toBe(false);
  });
});

describe('el QR de una persona', () => {
  it('vale el token o la URL entera de su página', () => {
    const t = 'AbCdEfGhIjKlMnOpQrStUvWx';
    expect(guestTokenFrom(t)).toBe(t);
    expect(guestTokenFrom(`https://api.example.com/reservas/q/${t}`)).toBe(t);
    expect(guestTokenFrom(`https://api.example.com/reservas/q/${t}?x=1`)).toBe(t);
    expect(guestTokenFrom('https://api.example.com/w/otro')).toBeNull();
  });
});
