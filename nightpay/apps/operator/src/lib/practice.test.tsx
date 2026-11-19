import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { encodeQr } from '@nightpay/ui';
import { authedFetch, fetchPaymentStatus } from './api';
import { CobroApiError, createCobro, fetchSaldoState, payByNfc, payByPin, type CobroCreado } from './api-cobro';
import { cobroOutcome } from './cobro-state';
import { PracticeBandView } from '@/components/PracticeBand';
import { PracticeSimulateView } from '@/components/PracticeSimulate';
import { PracticeMenuItemView } from '@/components/staff-menu';
import { PRACTICE_BAND_TEXT, PRACTICE_QR_TEXT, PracticeBlockedError, isPractice, setPractice } from './practice';
import {
  PRACTICE_BALANCE_CENTS,
  PRACTICE_PIN,
  PRACTICE_TAP,
  finishPracticeCobro,
  leavePractice,
  practiceFetch,
  resetPracticeSim,
  setPracticeNextAmount,
} from './practice-sim';

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  resetPracticeSim();
  setPractice(true);
});
afterEach(() => {
  setPractice(false);
  vi.unstubAllGlobals();
});

const LINES = [{ amountCents: 850, revenueCategory: 'VENUE_BAR' }] as never;
const NOOP = () => undefined;

describe('Modo práctica: nada que cambie datos llega a la red', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s no simulado nunca llama a fetch (por api.ts)', async (method) => {
    await expect(authedFetch('/v1/incidents/recepcion/ack', { method })).rejects.toBeInstanceOf(PracticeBlockedError);
    await expect(authedFetch('/v1/operators/me/payout-info', { method, body: '{}' })).rejects.toThrow(/modo práctica/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('las lecturas (GET) de la carta sí pasan al API; con la práctica apagada, todo pasa', async () => {
    const real = vi.fn().mockResolvedValue(new Response('[]'));
    await practiceFetch(true, '/v1/services', {}, real);
    expect(real).toHaveBeenCalledTimes(1);
    await practiceFetch(false, '/v1/anything', { method: 'POST' }, real);
    expect(real).toHaveBeenCalledTimes(2);
  });

  it('los cobros reales que podrían salir solos (por confirmar, sin pagar) llegan vacíos', async () => {
    const real = vi.fn();
    const res = await practiceFetch(true, '/v1/payments/pending-pos?zone=BARRA', {}, real);
    expect(await res.json()).toEqual([]);
    expect(real).not.toHaveBeenCalled();
  });
});

describe('Modo práctica: el simulador contesta con la forma del API', () => {
  it('un cobro: tarjeta y saldo, con ids PRACT- y el QR de texto plano', async () => {
    setPracticeNextAmount(850);
    const created: CobroCreado = await createCobro({ lines: LINES });
    expect(created.id.startsWith('PRACT-')).toBe(true);
    expect(created.saldo?.chargeId.startsWith('PRACT-')).toBe(true);
    expect(created.amountCents).toBe(850);
    expect(created.status).toBe('CREATED');
    expect(created.qrUrl).toBe(PRACTICE_QR_TEXT);
    expect(created.qrUrl.startsWith('http')).toBe(false);
    expect(encodeQr(created.qrUrl)).not.toBeNull();
    expect(typeof created.qrExpiresAt).toBe('string');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('el estado del saldo lleva los campos de SaldoState', async () => {
    const created = await createCobro({ lines: LINES });
    const state = await fetchSaldoState(created.saldo!.chargeId);
    expect(state).toMatchObject({ id: created.saldo!.chargeId, status: 'PENDING', amountCents: 850, newBalanceCents: null });
  });
});

describe('Modo práctica: el cobro llega a PAGADO y a NO PAGADO', () => {
  it('el cliente paga con la tarjeta: PAGADO', async () => {
    const created = await createCobro({ lines: LINES });
    expect((await fetchPaymentStatus(created.qrToken)).status).toBe('CREATED');
    finishPracticeCobro({ paymentId: created.id, chargeId: created.saldo?.chargeId }, 'paid');
    const polled = await fetchPaymentStatus(created.qrToken);
    expect(polled).toMatchObject({ status: 'AUTHORIZED', id: created.id, payMethod: 'card' });
    expect(cobroOutcome({ card: { status: polled.status }, saldo: null, localFail: null, canceledByMe: false }).kind).toBe('paid');
  });

  it('el cliente no paga: NO PAGADO', async () => {
    const created = await createCobro({ lines: LINES });
    finishPracticeCobro({ paymentId: created.id, chargeId: created.saldo?.chargeId }, 'fail');
    const polled = await fetchPaymentStatus(created.qrToken);
    expect(cobroOutcome({ card: { status: polled.status }, saldo: null, localFail: null, canceledByMe: false }).kind).toBe('failed');
  });

  it('la ficha: pide el PIN, el malo da el camino de PIN mal y 1234 cobra con lo que queda', async () => {
    setPracticeNextAmount(850);
    const created = await createCobro({ lines: LINES });
    const chargeId = created.saldo!.chargeId;
    const tapped = await payByNfc(chargeId, PRACTICE_TAP.token, PRACTICE_TAP.uid);
    expect(tapped.kind).toBe('pin');
    const ref = { card: PRACTICE_TAP.token, uid: PRACTICE_TAP.uid };
    const wrong = await payByPin(chargeId, ref, '0000').catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(CobroApiError);
    expect((wrong as CobroApiError).status).toBe(422);
    const paid = await payByPin(chargeId, ref, PRACTICE_PIN);
    expect(paid.status).toBe('ACCEPTED');
    expect(paid.newBalanceCents).toBe(PRACTICE_BALANCE_CENTS - 850);
    expect(cobroOutcome({ card: null, saldo: paid, localFail: null, canceledByMe: false })).toMatchObject({ kind: 'paid', newBalanceCents: 4150 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recepción: la recarga en efectivo suma a la ficha de práctica', async () => {
    const res = await authedFetch('/v1/reception/cash', { method: 'POST', body: JSON.stringify({ amountCents: 2000 }) });
    const out = await res.json();
    expect(out).toMatchObject({ amountCents: 2000, balanceCents: PRACTICE_BALANCE_CENTS + 2000, createdWallet: false, replayed: false });
    expect(out.topUpId.startsWith('PRACT-')).toBe(true);
  });
});

describe('Modo práctica: la franja, el menú y los botones', () => {
  it('la franja solo se pinta en práctica, con su frase', () => {
    expect(renderToStaticMarkup(<PracticeBandView on={false} />)).toBe('');
    expect(renderToStaticMarkup(<PracticeBandView on />)).toContain(PRACTICE_BAND_TEXT);
  });

  it('los botones de «Simular» solo existen en práctica; «Simular ficha» solo si se puede', () => {
    expect(renderToStaticMarkup(<PracticeSimulateView on={false} onPaid={NOOP} onFail={NOOP} />)).toBe('');
    const html = renderToStaticMarkup(<PracticeSimulateView on onPaid={NOOP} onFail={NOOP} />);
    expect(html).toContain('Simular: el cliente paga');
    expect(html).toContain('Simular: no paga');
    expect(html).not.toContain('Simular ficha');
    expect(renderToStaticMarkup(<PracticeSimulateView on onPaid={NOOP} onFail={NOOP} onFicha={NOOP} />)).toContain('Simular ficha');
  });

  it('el menú ofrece «Practicar» y, ya dentro, «Salir de práctica»', () => {
    expect(renderToStaticMarkup(<PracticeMenuItemView on={false} canStart onToggle={NOOP} />)).toContain('Practicar');
    expect(renderToStaticMarkup(<PracticeMenuItemView on canStart onToggle={NOOP} />)).toContain('Salir de práctica');
    // Con un cobro de verdad abierto no se empieza; salir siempre se puede.
    expect(renderToStaticMarkup(<PracticeMenuItemView on={false} canStart={false} onToggle={NOOP} />)).toBe('');
    expect(renderToStaticMarkup(<PracticeMenuItemView on canStart={false} onToggle={NOOP} />)).toContain('Salir de práctica');
  });

  it('salir apaga la práctica, borra lo simulado y recarga la app', () => {
    expect(isPractice()).toBe(true);
    const reload = vi.fn();
    leavePractice(reload);
    expect(isPractice()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
