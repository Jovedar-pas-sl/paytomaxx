import { describe, expect, it } from 'vitest';
import {
  CANCEL_WHILE_PAYING_TEXT,
  UNCONFIRMED_TITLE,
  cardWait,
  cardWaitParts,
  cardWaitText,
  cobroOutcome,
  serverToLocalMs,
  showsBankStrip,
  type CobroSignals,
} from './cobro-state';

const base: CobroSignals = { card: { status: 'CREATED' }, saldo: { status: 'PENDING', newBalanceCents: null }, localFail: null, canceledByMe: false };
const at = (o: Partial<CobroSignals>): CobroSignals => ({ ...base, ...o });

describe('el cobro único mientras espera: gana el primero', () => {
  it('esperando el NFC o el QR', () => {
    expect(cobroOutcome(base)).toEqual({ kind: 'waiting' });
    expect(cobroOutcome(at({ card: { status: 'AUTHORIZING' } }))).toEqual({ kind: 'waiting' });
  });

  it('pagado con el saldo: cómo y lo que le queda (aunque la tarjeta ya diga cancelada)', () => {
    expect(
      cobroOutcome(at({ card: { status: 'CANCELED' }, saldo: { status: 'ACCEPTED', paidWith: 'pin', newBalanceCents: 3000, tipCents: 500 } })),
    ).toEqual({ kind: 'paid', method: 'pin', newBalanceCents: 3000, tipCents: 500 });
    expect(cobroOutcome(at({ saldo: { status: 'ACCEPTED', newBalanceCents: 0 } }))).toMatchObject({ kind: 'paid', method: 'nfc_nopin' });
  });

  it('pagado con la tarjeta (con su propina); el saldo, cancelado', () => {
    expect(cobroOutcome(at({ card: { status: 'AUTHORIZED', tipCents: 200 }, saldo: { status: 'CANCELED', newBalanceCents: null } }))).toEqual({
      kind: 'paid',
      method: 'card',
      newBalanceCents: null,
      tipCents: 200,
    });
  });

  it('pagado con la tarjeta antes de saber su propina (llegó solo el estado): propina desconocida, no 0', () => {
    expect(cobroOutcome(at({ card: { status: 'AUTHORIZED' }, saldo: null }))).toEqual({
      kind: 'paid',
      method: 'card',
      newBalanceCents: null,
      tipCents: null,
    });
  });

  it('la tarjeta cancelada con el saldo aún pendiente aquí: se espera a la próxima consulta (lo pagó el saldo)', () => {
    expect(cobroOutcome(at({ card: { status: 'CANCELED' } }))).toEqual({ kind: 'waiting' });
    expect(cobroOutcome(at({ card: { status: 'CANCELED' }, saldo: { status: 'CANCELED', newBalanceCents: null } }))).toEqual({ kind: 'canceled' });
  });

  it('el NFC no pagó: NO PAGADO con la razón; el QR sigue valiendo', () => {
    const reason = { title: 'Saldo insuficiente', sentence: 'Tiene 30 €.' };
    expect(cobroOutcome(at({ localFail: reason }))).toEqual({ kind: 'failed', reason, qrStillOpen: true });
    expect(cobroOutcome(at({ localFail: reason, card: { status: 'EXPIRED' }, saldo: { status: 'EXPIRED', newBalanceCents: null } }))).toMatchObject({
      qrStillOpen: false,
    });
  });

  it('tarjeta rechazada, caducado y cancelado', () => {
    expect(cobroOutcome(at({ card: { status: 'FAILED' } }))).toMatchObject({ kind: 'failed', reason: { title: 'Tarjeta rechazada' } });
    expect(cobroOutcome(at({ card: { status: 'EXPIRED' } }))).toEqual({ kind: 'expired' });
    expect(cobroOutcome(at({ card: null, saldo: { status: 'EXPIRED', newBalanceCents: null } }))).toEqual({ kind: 'expired' });
    expect(cobroOutcome(at({ card: null, saldo: { status: 'CANCELED', newBalanceCents: null } }))).toEqual({ kind: 'canceled' });
    expect(cobroOutcome(at({ canceledByMe: true }))).toEqual({ kind: 'canceled' });
    expect(cobroOutcome(at({ card: { status: 'CREATED' }, saldo: null }))).toEqual({ kind: 'waiting' });
  });
});

describe('el cliente paga con tarjeta: lo que ve el camarero mientras el banco contesta (05-ui-ux §4.3)', () => {
  const SENT = Date.parse('2026-10-14T00:00:00Z');
  const QR_OPEN = SENT + 10 * 60_000;
  const wait = (seconds: number, qrExpiresAtMs: number | null = QR_OPEN, status: 'AUTHORIZING' | 'CREATED' = 'AUTHORIZING') =>
    cardWait({ status, attemptStartedAtMs: SENT, qrExpiresAtMs, nowMs: SENT + seconds * 1000 });

  it('sin intento en el banco: esperando que escanee (lo de siempre)', () => {
    expect(wait(5, QR_OPEN, 'CREATED')).toEqual({ stage: 'scan', elapsedMs: 0 });
    expect(cardWait({ status: 'AUTHORIZING', attemptStartedAtMs: null, qrExpiresAtMs: QR_OPEN, nowMs: SENT })).toEqual({ stage: 'scan', elapsedMs: 0 });
    expect(cardWaitText(wait(5, QR_OPEN, 'CREATED'))).toBeNull();
  });

  it('0–20 s: «El cliente está pagando… 0:05», con su reloj', () => {
    expect(wait(5)).toEqual({ stage: 'paying', elapsedMs: 5_000 });
    expect(cardWaitText(wait(5))).toBe('El cliente está pagando… 0:05');
    expect(cardWaitText(wait(19.9))).toBe('El cliente está pagando… 0:19');
  });

  it('20–60 s: la franja ámbar «El banco está tardando · No cobres otra vez»', () => {
    expect(wait(20).stage).toBe('slow');
    expect(wait(59).stage).toBe('slow');
    expect(cardWaitText(wait(34))).toBe('El banco está tardando · No cobres otra vez');
  });

  it('60–150 s: «Sigue esperando al banco · 1:12»', () => {
    expect(wait(60).stage).toBe('still');
    expect(cardWaitText(wait(72))).toBe('Sigue esperando al banco · 1:12');
    expect(wait(149).stage).toBe('still');
  });

  it('más de 150 s con el QR vigente: «El cliente puede volver a intentarlo»; con el QR caducado, sigue esperando al banco', () => {
    expect(wait(150).stage).toBe('retry');
    expect(cardWaitText(wait(151))).toBe('El cliente puede volver a intentarlo');
    expect(wait(151, SENT + 140_000).stage).toBe('still');
    expect(cardWaitText(wait(200, SENT + 140_000))).toBe('Sigue esperando al banco · 3:20');
    // Sin saber el plazo del QR, no se le dice que reintente.
    expect(wait(200, null).stage).toBe('still');
  });

  it('un reloj del móvil por delante del servidor no da tiempos negativos', () => {
    expect(cardWait({ status: 'AUTHORIZING', attemptStartedAtMs: SENT + 3_000, qrExpiresAtMs: QR_OPEN, nowMs: SENT })).toEqual({
      stage: 'paying',
      elapsedMs: 0,
    });
  });

  it('ORPHAN: «El banco no lo ha confirmado» (nunca vuelve a la espera ni a «Otro QR»); si lo paga el saldo, pagado', () => {
    expect(cobroOutcome(at({ card: { status: 'ORPHAN' } }))).toEqual({ kind: 'unconfirmed' });
    expect(cobroOutcome(at({ card: { status: 'ORPHAN' }, saldo: null }))).toEqual({ kind: 'unconfirmed' });
    expect(cobroOutcome(at({ card: { status: 'ORPHAN' }, saldo: { status: 'ACCEPTED', newBalanceCents: 0 } }))).toMatchObject({ kind: 'paid' });
    // Luego el banco lo aprueba: PAGADO.
    expect(cobroOutcome(at({ card: { status: 'AUTHORIZED' } }))).toMatchObject({ kind: 'paid', method: 'card' });
    expect(UNCONFIRMED_TITLE).toBe('El banco no lo ha confirmado');
  });

  it('el lector de pantalla oye la fase, no el reloj; la franja ámbar desde los 20 s', () => {
    expect(cardWaitParts(wait(5))).toEqual({ label: 'El cliente está pagando…', clock: '0:05' });
    expect(cardWaitParts(wait(6))?.label).toBe(cardWaitParts(wait(5))?.label);
    expect(cardWaitParts(wait(72))).toEqual({ label: 'Sigue esperando al banco ·', clock: '1:12' });
    expect(cardWaitParts(wait(5, QR_OPEN, 'CREATED'))).toBeNull();
    expect([5, 25, 90, 160].map((sec) => showsBankStrip(wait(sec)))).toEqual([false, true, true, true]);
  });

  it('la hora del servidor en el reloj del móvil, con el plazo del QR como ancla', () => {
    // El móvil va 40 s por detrás: el plazo del QR del servidor (12:10:00) aquí es 12:09:20.
    const anchor = { serverMs: Date.parse('2026-10-14T12:10:00Z'), localMs: Date.parse('2026-10-14T12:09:20Z') };
    expect(serverToLocalMs(Date.parse('2026-10-14T12:05:00Z'), anchor)).toBe(Date.parse('2026-10-14T12:04:20Z'));
    expect(serverToLocalMs(1_000, null)).toBe(1_000);
  });

  it('cancelar mientras el cliente paga en su banco pide confirmarlo', () => {
    expect(CANCEL_WHILE_PAYING_TEXT).toBe('¿Cancelar? El cliente está pagando en su banco.');
  });
});
