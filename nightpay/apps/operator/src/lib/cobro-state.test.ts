import { describe, expect, it } from 'vitest';
import {
  BITCOIN_CONFIRMING_CODE,
  BITCOIN_CONFIRMING_TEXT,
  BITCOIN_PROBLEM_TEXT,
  CANCEL_AT_BANK_TEXT,
  CANCEL_CONFIRM_TITLE,
  LEAVE_WITHOUT_CHARGING,
  UNCONFIRMED_TITLE,
  bitcoinWaitText,
  bankCancelOf,
  cancelAtBank,
  cancelFailedText,
  cancelOffer,
  cardAfter,
  cardWait,
  cardWaitParts,
  cardWaitText,
  cobroOutcome,
  payingWithBitcoin,
  serverToLocalMs,
  showsBankStrip,
  type CardLive,
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

  it('«Cancelar cobro» siempre pide confirmar; con el cliente en su banco, además, avisa de que si lo cobra después se devuelve', () => {
    expect(CANCEL_CONFIRM_TITLE).toBe('¿Cancelar este cobro?');
    expect(CANCEL_AT_BANK_TEXT).toBe('Si su banco lo cobra después, te avisaremos para devolverlo');
    expect(cancelAtBank({ status: 'AUTHORIZING', bitcoin: null })).toBe(true);
    expect(cancelAtBank({ status: 'AUTHORIZING', bitcoin: 'unknown' })).toBe(true);
    expect(cancelAtBank({ status: 'AUTHORIZING', bitcoin: 'open' })).toBe(false);
    expect(cancelAtBank({ status: 'AWAITING_CAPTURE', bitcoin: null })).toBe(false);
  });
});

describe('el cliente paga con bitcoin: «Cancelar cobro» mientras la factura espera el pago', () => {
  const card = (status: CardLive['status'], bitcoin: CardLive['bitcoin'] = null): CardLive => ({ status, bitcoin });

  it('con la factura de bitcoin esperando el pago: el botón «Cancelar cobro» (el API cierra la factura)', () => {
    expect(cancelOffer(card('AUTHORIZING', 'open'))).toEqual({ kind: 'button' });
  });

  it('con tarjeta, en su banco: los primeros 2 minutos solo el texto; después, el texto y el botón', () => {
    expect(cancelOffer(card('AUTHORIZING'), 'wait')).toEqual({ kind: 'text', text: 'El cliente está pagando en su banco' });
    expect(cancelOffer(card('AUTHORIZING', 'unknown'), 'wait')).toEqual({ kind: 'text', text: 'El cliente está pagando en su banco' });
    expect(cancelOffer(card('AUTHORIZING'), 'late')).toEqual({ kind: 'late', text: 'El banco tarda. Si el cliente no ha pagado, puedes cancelar' });
  });

  it('cobrado en el datáfono sin comprobar: nunca el botón, se sale sin cancelar', () => {
    expect(cancelOffer(card('AUTHORIZING'), 'held')).toEqual({ kind: 'leave', text: 'Cobrado en el datáfono, pendiente de comprobar' });
  });

  it('el reloj es el de la espera del banco (el de la pastilla): 2 minutos desde que salió el intento', () => {
    const at = (stage: 'scan' | 'paying' | 'still' | 'retry', sec: number) => ({ stage, elapsedMs: sec * 1000 });
    expect(bankCancelOf(true, at('paying', 5))).toBe('wait');
    expect(bankCancelOf(true, at('still', 119))).toBe('wait');
    expect(bankCancelOf(true, at('still', 120))).toBe('late');
    expect(bankCancelOf(true, at('retry', 200))).toBe('late');
    // Sin saber aún desde cuándo (antes del primer sondeo): sin botón.
    expect(bankCancelOf(true, at('scan', 0))).toBe('wait');
    // Fuera del banco (sin empezar o con bitcoin), como siempre.
    expect(bankCancelOf(false, at('scan', 0))).toBe('free');
    expect(cancelOffer(card('AUTHORIZING', 'open'), bankCancelOf(cancelAtBank(card('AUTHORIZING', 'open')), at('scan', 0)))).toEqual({ kind: 'button' });
  });

  it('el API dice que aún no (409 CANCEL_AT_BANK_TOO_SOON): se dice que espere', () => {
    expect(cancelFailedText(card('AUTHORIZING'), 'CANCEL_AT_BANK_TOO_SOON')).toBe(
      'El cliente sigue pagando en su banco: aún no se puede cancelar. Espera un poco.',
    );
  });

  it('con el bitcoin ya en la red (falta la confirmación) o con un problema: sin «Cancelar», sin hablar del banco y con «Salir sin cobrar otra vez»', () => {
    expect(cancelOffer(card('AUTHORIZING', 'confirming'))).toEqual({ kind: 'leave', text: BITCOIN_CONFIRMING_TEXT });
    expect(cancelOffer(card('AUTHORIZING', 'problem'))).toEqual({ kind: 'leave', text: BITCOIN_PROBLEM_TEXT });
    for (const text of [BITCOIN_CONFIRMING_TEXT, BITCOIN_PROBLEM_TEXT]) expect(text).not.toMatch(/banco/i);
  });

  it('sin empezar a pagar: el botón, como siempre', () => {
    expect(cancelOffer(card('CREATED'))).toEqual({ kind: 'button' });
    expect(cancelOffer(card('AWAITING_CAPTURE', 'open'))).toEqual({ kind: 'button' });
  });

  it('si el API no dice si paga con bitcoin (uno de antes): cuenta como en su banco y decide el servidor', () => {
    expect(cancelAtBank(card('AUTHORIZING', 'unknown'))).toBe(true);
    expect(payingWithBitcoin(card('AUTHORIZING', 'unknown'))).toBeNull();
    expect(cancelFailedText(card('AUTHORIZING', 'unknown'), null)).toMatch(/en su banco o con bitcoin/);
  });

  it('si cancelar falla: la razón sin «banco» cuando paga con bitcoin; la de siempre con tarjeta', () => {
    expect(cancelFailedText(card('AUTHORIZING', 'open'), null)).toBe(
      'No se ha podido cancelar: puede que el cliente acabe de pagar con bitcoin. Mira si ya está pagado.',
    );
    expect(cancelFailedText(card('AUTHORIZING', 'open'), BITCOIN_CONFIRMING_CODE)).toBe(BITCOIN_CONFIRMING_TEXT);
    expect(cancelFailedText(card('AUTHORIZING', 'confirming'), null)).toBe(BITCOIN_CONFIRMING_TEXT);
    expect(cancelFailedText(card('AUTHORIZING'), null)).toBe('No se ha podido cancelar: mira si ya está pagado.');
    expect(cancelFailedText(card('AWAITING_CAPTURE'), null)).toBe('No se ha podido cancelar: mira si ya está pagado.');
    expect(cancelFailedText(card('AUTHORIZING', 'open'), null)).not.toMatch(/banco/i);
  });

  it('la pastilla viva dice bitcoin, no las fases del banco', () => {
    expect(bitcoinWaitText('open')).toBe('El cliente está pagando con bitcoin…');
    expect(bitcoinWaitText('confirming')).toBe('Pagado con bitcoin · falta 1 confirmación de la red');
    expect(bitcoinWaitText('problem')).toBe('Problema con el pago en bitcoin');
  });
});

describe('el estado del cobro en pantalla con bitcoin (tiempo real y sondeo)', () => {
  const start: CardLive = { status: 'AWAITING_CAPTURE', bitcoin: null };

  it('abre la factura: AUTHORIZING por el tiempo real y, con el sondeo, el estado de la factura', () => {
    const live = cardAfter(start, { status: 'AUTHORIZING' });
    expect(live).toEqual({ status: 'AUTHORIZING', bitcoin: null });
    expect(cardAfter(live, { status: 'AUTHORIZING', bitcoin: 'open' })).toEqual({ status: 'AUTHORIZING', bitcoin: 'open' });
  });

  it('el tiempo real (sin la factura) no borra lo que dijo el sondeo', () => {
    const open: CardLive = { status: 'AUTHORIZING', bitcoin: 'open' };
    expect(cardAfter(open, { status: 'AUTHORIZING' })).toBe(open);
  });

  it('la factura se cerró sin pagar («Pagar de otra forma» o caducó): vuelve a estar abierto (la única vuelta atrás)', () => {
    const open: CardLive = { status: 'AUTHORIZING', bitcoin: 'open' };
    expect(cardAfter(open, { status: 'AWAITING_CAPTURE' })).toEqual({ status: 'AWAITING_CAPTURE', bitcoin: null });
  });

  it('con tarjeta, en su banco, una respuesta vieja no hace retroceder la pantalla (como siempre)', () => {
    const bank: CardLive = { status: 'AUTHORIZING', bitcoin: null };
    expect(cardAfter(bank, { status: 'AWAITING_CAPTURE' })).toBe(bank);
    expect(cardAfter({ status: 'AUTHORIZED', bitcoin: null }, { status: 'AUTHORIZING', bitcoin: 'open' }).status).toBe('AUTHORIZED');
  });

  it('del bitcoin a la tarjeta: al volver a AUTHORIZING con el banco, el sondeo lo dice (null) y al cancelar se avisa del banco', () => {
    const reopened = cardAfter({ status: 'AUTHORIZING', bitcoin: 'open' }, { status: 'AWAITING_CAPTURE' });
    const bank = cardAfter(cardAfter(reopened, { status: 'AUTHORIZING' }), { status: 'AUTHORIZING', bitcoin: null });
    expect(bank).toEqual({ status: 'AUTHORIZING', bitcoin: null });
    expect(cancelAtBank(bank)).toBe(true);
    expect(cancelOffer(bank, 'wait')).toEqual({ kind: 'text', text: 'El cliente está pagando en su banco' });
  });

  it('pagado: PAGADO (la factura deja de contar)', () => {
    expect(cardAfter({ status: 'AUTHORIZING', bitcoin: 'confirming' }, { status: 'AUTHORIZED' })).toEqual({ status: 'AUTHORIZED', bitcoin: null });
  });

  it('cerrada antes de que el sondeo dijera que era bitcoin: el API dice «closed» y la pantalla vuelve igual (no se queda con la frase del banco)', () => {
    // Solo llegó el AUTHORIZING del tiempo real (sin la factura) y el cliente eligió pagar de otra forma enseguida.
    const unknown: CardLive = { status: 'AUTHORIZING', bitcoin: null };
    const back = cardAfter(unknown, { status: 'AWAITING_CAPTURE', bitcoin: 'closed' });
    expect(back).toEqual({ status: 'AWAITING_CAPTURE', bitcoin: 'closed' });
    expect(cancelOffer(back)).toEqual({ kind: 'button' });
    expect(payingWithBitcoin(back)).toBeNull();
    // Y si luego paga con tarjeta, en su banco: de bitcoin no queda nada.
    expect(cardAfter(back, { status: 'AUTHORIZING' })).toEqual({ status: 'AUTHORIZING', bitcoin: null });
  });

  it('paga con bitcoin ahora mismo: solo en AUTHORIZING con su factura', () => {
    expect(payingWithBitcoin({ status: 'AUTHORIZING', bitcoin: 'open' })).toBe('open');
    expect(payingWithBitcoin({ status: 'AUTHORIZING', bitcoin: 'confirming' })).toBe('confirming');
    expect(payingWithBitcoin({ status: 'AUTHORIZING', bitcoin: null })).toBeNull();
    expect(payingWithBitcoin({ status: 'AWAITING_CAPTURE', bitcoin: 'open' })).toBeNull();
    expect(payingWithBitcoin({ status: 'AUTHORIZING', bitcoin: 'closed' })).toBeNull();
  });

  it('salir sin cobrar otra vez: la frase de siempre (como con el banco sin confirmar)', () => {
    expect(LEAVE_WITHOUT_CHARGING).toBe('Salir sin cobrar otra vez');
  });
});
