import { describe, expect, it } from 'vitest';
import { PAYOUT_BATCH_CHANGED_MESSAGE, PAYOUT_BATCH_NEEDS_APPROVAL_MESSAGE } from '@nightpay/contracts';
import { ApiError } from './api-errors';
import type { Operator } from './api';
import { formatDateTime } from './dates';
import { PayoutBatchChangedError } from './endpoints/operators';
import {
  BATCH_2FA_TEXT,
  BATCH_LOST_TEXT,
  BATCH_MAX,
  NO_PERMISSION_TEXT,
  allToggle,
  barText,
  batchAccess,
  batchFailure,
  keepTicked,
  methodWord,
  notesAfter,
  payoutModeFor,
  personName,
  problemText,
  resultMark,
  resultTitle,
  reviewTexts,
  rowState,
  tickAll,
  tickDisabled,
} from './payout-batch';
import { KEY_REUSED_TEXT, newKey } from './payout-attempt';

const TZ = 'Europe/Madrid';
const NOW = Date.parse('2026-11-26T20:00:00Z');

function op(over: Partial<Operator> = {}): Operator {
  return {
    id: 'op-1',
    email: 'marta@x.es',
    displayName: 'Marta',
    commissionBps: 5000,
    active: true,
    invitedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    balance: { pendingCents: 30_000, availableCents: 30_000, paidCents: 0, lifetimeGrossCents: 0, count: 3 },
    payoutMethod: 'SEPA_IBAN',
    payoutAddressMasked: 'ES12 •••• •••• 4821',
    ...over,
  };
}

describe('quién marca (roles y segundo factor)', () => {
  it('payoutModeFor pasa a lib: el dueño paga; el encargado pide o paga con 2FA; si no, nada', () => {
    expect(payoutModeFor(true, undefined)).toBe('pay');
    expect(payoutModeFor(false, 'request')).toBe('request');
    expect(payoutModeFor(false, 'direct_2fa')).toBe('pay_2fa');
    expect(payoutModeFor(false, 'forbidden')).toBeNull();
    expect(payoutModeFor(false, undefined)).toBeNull();
  });

  it('marcan el dueño y el encargado con direct_2fa y permiso, si tienen 2FA o llave (o aún no se sabe)', () => {
    expect(batchAccess({ isOwner: true, rule: 'direct', canPay: true, method: 'totp' })).toBe('tick');
    expect(batchAccess({ isOwner: true, rule: undefined, canPay: undefined, method: undefined })).toBe('tick');
    expect(batchAccess({ isOwner: false, rule: 'direct_2fa', canPay: true, method: 'passkey' })).toBe('tick');
  });

  it('sin 2FA ni llave: una a una', () => {
    expect(batchAccess({ isOwner: true, rule: 'direct', canPay: true, method: null })).toBe('one-by-one');
    expect(batchAccess({ isOwner: false, rule: 'direct_2fa', canPay: true, method: null })).toBe('one-by-one');
  });

  it('el encargado que pide: «Pedir al dueño» por fila; sin permiso: solo mirar; sin reglas: solo mirar', () => {
    expect(batchAccess({ isOwner: false, rule: 'request', canPay: true, method: 'totp' })).toBe('request');
    expect(batchAccess({ isOwner: false, rule: 'direct_2fa', canPay: false, method: 'totp' })).toBe('no-permission');
    expect(batchAccess({ isOwner: false, rule: undefined, canPay: true, method: 'totp' })).toBe('look');
    expect(batchAccess({ isOwner: false, rule: 'direct_2fa', canPay: undefined, method: 'totp' })).toBe('look');
    expect(NO_PERMISSION_TEXT).toBe('No tienes permiso para pagar');
  });
});

describe('cada fila', () => {
  it('se marca con método no efectivo, cuenta, sin espera ni titular sin confirmar', () => {
    expect(rowState(op(), NOW)).toEqual({ kind: 'tick', cents: 30_000 });
  });

  it('el titular que no se parece se marca igual', () => {
    expect(rowState(op({ payoutHolderMismatch: true }), NOW)).toEqual({ kind: 'tick', cents: 30_000 });
  });

  it('sin casilla: efectivo, sin cuenta, 48 h y titular sin confirmar, con su código', () => {
    expect(rowState(op({ payoutMethod: 'MANUAL_CASH', payoutAddressMasked: null }), NOW)).toEqual({ kind: 'blocked', code: 'CASH' });
    expect(rowState(op({ payoutMethod: null, payoutAddressMasked: null }), NOW)).toEqual({ kind: 'blocked', code: 'NO_ACCOUNT' });
    expect(rowState(op({ payoutAddressMasked: null }), NOW)).toEqual({ kind: 'blocked', code: 'NO_ACCOUNT' });
    const until = '2026-11-27T17:30:00Z';
    expect(rowState(op({ payoutHoldUntil: until }), NOW)).toEqual({ kind: 'blocked', code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: until });
    expect(rowState(op({ payoutHoldUntil: '2026-11-26T19:00:00Z' }), NOW)).toEqual({ kind: 'tick', cents: 30_000 });
    expect(rowState(op({ payoutHolderUnconfirmed: true }), NOW)).toEqual({ kind: 'blocked', code: 'PAYOUT_HOLDER_UNCONFIRMED' });
  });

  it('con solicitud pendiente: quién la pidió; sin availableCents (API antiguo): sin casilla', () => {
    expect(rowState(op(), NOW, 'Luis')).toEqual({ kind: 'pending', by: 'Luis' });
    expect(rowState(op({ balance: { pendingCents: 500, paidCents: 0, lifetimeGrossCents: 0, count: 1 } }), NOW)).toEqual({ kind: 'unknown' });
  });

  it('el nombre: «Luis · camarero» si lo es', () => {
    expect(personName(op(), false)).toBe('Marta');
    expect(personName(op({ displayName: 'Luis' }), true)).toBe('Luis · camarero');
    expect(personName(op({ displayName: null }), false)).toBe('marta@x.es');
  });

  it('methodWord: SEPA y Wire son «Transferencia»; lo demás, su nombre corto', () => {
    expect(methodWord('SEPA_IBAN')).toBe('Transferencia');
    expect(methodWord('WIRE_INTERNATIONAL')).toBe('Transferencia');
    expect(methodWord('USDT_TRC20')).toBe('USDT TRC20');
    expect(methodWord('BINANCE_PAY_ID')).toBe('Binance Pay');
  });
});

describe('«Todas» y el tope de 50', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `op-${i}`);
  const cents = new Map(ids.map((id) => [id, 100]));

  it('«Todas» marca como mucho 50, en orden; otra vez, desmarca', () => {
    const all = tickAll(ids, cents, new Map());
    expect(all.size).toBe(BATCH_MAX);
    expect(BATCH_MAX).toBe(50);
    expect([...all.keys()]).toEqual(ids.slice(0, 50));
    expect(tickAll(ids, cents, all).size).toBe(0);
  });

  it('indeterminada si van algunas; marcada si van todas (o 50)', () => {
    expect(allToggle(ids.slice(0, 3), new Map())).toEqual({ checked: false, indeterminate: false });
    expect(allToggle(ids.slice(0, 3), new Map([['op-0', 100]]))).toEqual({ checked: false, indeterminate: true });
    expect(allToggle(ids.slice(0, 3), new Map(ids.slice(0, 3).map((id) => [id, 100])))).toEqual({ checked: true, indeterminate: false });
    expect(allToggle(ids, tickAll(ids, cents, new Map()))).toEqual({ checked: true, indeterminate: false });
  });

  it('con 50 marcadas, las demás apagadas', () => {
    const full = tickAll(ids, cents, new Map());
    expect(tickDisabled('op-55', full)).toBe(true);
    expect(tickDisabled('op-3', full)).toBe(false);
    expect(tickDisabled('op-55', new Map([['op-0', 1]]))).toBe(false);
  });
});

describe('la barra fija', () => {
  it('«Pagar a 6: 1.840,00\u00a0€»; sin nadie, «Marca a quién pagas»', () => {
    const ticked = new Map([
      ['a', 100_000],
      ['b', 84_000],
    ]);
    expect(barText(ticked)).toBe('Pagar a 2: 1.840,00\u00a0€');
    expect(barText(new Map())).toBe('Marca a quién pagas');
  });
});

describe('el repaso', () => {
  it('plural y singular', () => {
    expect(reviewTexts(6)).toEqual({
      title: 'Repasa los 6 pagos',
      confirm: 'Ya he pagado estos 6 importes, cada uno a su cuenta',
      submit: 'Apuntar 6 pagos',
      sending: 'Apuntando 6 pagos…',
      reason: 'Para apuntar 6 pagos',
      next: 'Ahora pulsa «Apuntar 6 pagos».',
    });
    expect(reviewTexts(1)).toEqual({
      title: 'Repasa el pago',
      confirm: 'Ya he pagado este importe a su cuenta',
      submit: 'Apuntar 1 pago',
      sending: 'Apuntando 1 pago…',
      reason: 'Para apuntar 1 pago',
      next: 'Ahora pulsa «Apuntar 1 pago».',
    });
  });

  it('una clave nueva cada vez (cabe en la acción de la llave)', () => {
    const a = newKey();
    expect(a).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(newKey()).not.toBe(a);
  });
});

describe('los textos de cada problema (nunca el mensaje del servidor)', () => {
  it('uno por código', () => {
    const t = (code: Parameters<typeof problemText>[0]['code'], extra = {}) => problemText({ code, ...extra }, { tz: TZ, expectedCents: 30_000 });
    expect(t('NOT_FOUND')).toBe('Ya no está en el local');
    expect(t('NO_ACCOUNT')).toBe('Sin cuenta de cobro: se paga una a una');
    expect(t('CASH')).toBe('Cobra en efectivo: se paga una a una');
    const from = '2026-11-12T17:30:00Z';
    expect(t('PAYOUT_ACCOUNT_TOO_NEW', { payableFrom: from })).toBe(
      `Cuenta cambiada hace poco: se le puede pagar desde el ${formatDateTime(from, TZ, 'short')}`,
    );
    expect(t('PAYOUT_ACCOUNT_TOO_NEW', { payableFrom: from })).toBe('Cuenta cambiada hace poco: se le puede pagar desde el 12 nov, 18:30');
    expect(t('PAYOUT_HOLDER_UNCONFIRMED')).toBe('Falta confirmar que la cuenta es suya');
    expect(t('APPROVAL_ALREADY_PENDING')).toBe('Ya está pedido al dueño');
    expect(t('PAYOUT_CHANGED', { totalCents: 31_000 })).toBe('Ahora son 310,00\u00a0€, no 300,00\u00a0€');
    expect(t('NOTHING_TO_PAY')).toBe('Ya no tiene nada por cobrar: puede que se le acabe de pagar');
    expect(t('UNKNOWN')).toBe('No sabemos si se apuntó: mira su ficha antes de volver a pagarle');
    expect(t('SKIPPED')).toBe('Sin apuntar: se paró antes de llegar a ella');
    expect(t('OTHER')).toBe('No se pudo apuntar');
  });
});

describe('el resultado', () => {
  const paid = (id: string, cents: number) => ({ operatorId: id, status: 'PAID' as const, payoutId: '00000000-0000-4000-8000-000000000001', totalCents: cents });

  it('bien: «6 pagos apuntados · 1.840,00\u00a0€» (la suma del API), «1 pago apuntado»', () => {
    expect(resultTitle({ results: [paid('a', 100_000), paid('b', 84_000)], paidCount: 2, paidCents: 184_000 })).toBe('2 pagos apuntados · 1.840,00\u00a0€');
    expect(resultTitle({ results: [paid('a', 100)], paidCount: 1, paidCents: 100 })).toBe('1 pago apuntado · 1,00\u00a0€');
  });

  it('a medias: «Apuntados 4 de 6 · 1.240,00\u00a0€» y la marca de cada una', () => {
    const results = [
      paid('a', 124_000),
      { operatorId: 'b', status: 'FAILED' as const, code: 'PAYOUT_CHANGED' as const, totalCents: 1 },
      { operatorId: 'c', status: 'FAILED' as const, code: 'UNKNOWN' as const },
      { operatorId: 'd', status: 'SKIPPED' as const, code: 'SKIPPED' as const },
    ];
    expect(resultTitle({ results, paidCount: 1, paidCents: 124_000 })).toBe('Apuntados 1 de 4 · 1.240,00\u00a0€');
    expect(results.map(resultMark)).toEqual(['check', 'close', 'clock', 'minus']);
  });

  it('las que no se pagaron se desmarcan con su texto (las pagadas, no)', () => {
    const notes = notesAfter([
      paid('a', 1),
      { operatorId: 'b', status: 'FAILED', code: 'CASH' },
      { operatorId: 'c', status: 'SKIPPED' },
    ]);
    expect(notes).toEqual([
      { operatorId: 'b', code: 'CASH' },
      { operatorId: 'c', code: 'SKIPPED' },
    ]);
  });
});

describe('al recargar la lista', () => {
  it('siguen marcadas las de igual cifra; con otra cifra o con problema, no', () => {
    const prev = new Map([
      ['a', 100],
      ['b', 200],
      ['c', 300],
      ['d', 400],
    ]);
    const now = new Map([
      ['a', 100],
      ['b', 250],
      ['c', 300],
    ]);
    expect([...keepTicked(prev, now, new Set(['c'])).entries()]).toEqual([['a', 100]]);
  });
});

describe('batchFailure', () => {
  it('PAYOUT_BATCH_CHANGED: los problemas de cada fila (y la clave muere)', () => {
    const problems = [{ operatorId: '00000000-0000-4000-8000-000000000001', code: 'CASH' as const }];
    expect(batchFailure(new PayoutBatchChangedError(problems), NOW)).toEqual({ kind: 'changed', text: PAYOUT_BATCH_CHANGED_MESSAGE, problems, keyDies: true });
  });

  it('sin respuesta o 5xx: no sabemos (la clave muere)', () => {
    for (const err of [new Error('x'), new ApiError('a', 0), new ApiError('b', 502)]) {
      expect(batchFailure(err, NOW)).toEqual({ kind: 'unknown', text: BATCH_LOST_TEXT, keyDies: true });
    }
    expect(BATCH_LOST_TEXT).toBe(
      'No sabemos si se apuntaron todos: el servidor no contestó y puede que siga apuntándolos. Espera un minuto y pulsa «Volver a cargar la lista» antes de repetir nada.',
    );
  });

  it('TOTP_INVALID vacía el código y deja probar otro con la misma clave', () => {
    const f = batchFailure(new ApiError('Código incorrecto', 403, 'TOTP_INVALID'), NOW);
    expect(f).toMatchObject({ kind: 'retry', clearCode: true, keyDies: false });
    expect(f.text).toContain('Código incorrecto');
  });

  it('429: hasta cuándo no se puede probar otro', () => {
    const f = batchFailure(new ApiError('Demasiados intentos. Espera 12 min', 429, 'TOTP_LOCKED'), NOW);
    expect(f).toMatchObject({ kind: 'locked', until: NOW + 12 * 60_000, keyDies: false });
  });

  it('sin 2FA: el texto del encargo; PASSKEY_REQUIRED: con la llave', () => {
    expect(batchFailure(new ApiError('not enrolled', 403, 'TOTP_NOT_ENROLLED'), NOW)).toEqual({ kind: 'retry', text: BATCH_2FA_TEXT, clearCode: true, keyDies: false });
    expect(BATCH_2FA_TEXT).toBe(
      'Para pagar a varias a la vez hace falta la verificación en dos pasos o una llave de acceso (Ajustes → Seguridad). Mientras, págales una a una.',
    );
    expect(batchFailure(new ApiError('x', 403, 'PASSKEY_REQUIRED'), NOW)).toMatchObject({ kind: 'passkey', keyDies: false });
  });

  it('el encargado que ya pide o sin permiso: su texto, recargar y cerrar', () => {
    expect(batchFailure(new ApiError('lo que diga el servidor', 409, 'PAYOUT_BATCH_NEEDS_APPROVAL'), NOW)).toEqual({
      kind: 'close',
      text: PAYOUT_BATCH_NEEDS_APPROVAL_MESSAGE,
      keyDies: true,
    });
    expect(batchFailure(new ApiError('lo que diga el servidor', 403, 'STAFF_PERMISSION_DENIED'), NOW)).toEqual({
      kind: 'close',
      text: NO_PERMISSION_TEXT,
      keyDies: false,
    });
  });

  it('IDEMPOTENCY_KEY_REUSED: el texto de payoutFailure', () => {
    expect(batchFailure(new ApiError('x', 409, 'IDEMPOTENCY_KEY_REUSED'), NOW)).toEqual({ kind: 'dead', text: KEY_REUSED_TEXT, keyDies: true });
  });

  it('otro error: nunca el mensaje del servidor', () => {
    const f = batchFailure(new ApiError('Internal detail XYZ', 400, 'VALIDATION'), NOW);
    expect(f.text).not.toContain('XYZ');
    expect(f.kind).toBe('retry');
  });
});
