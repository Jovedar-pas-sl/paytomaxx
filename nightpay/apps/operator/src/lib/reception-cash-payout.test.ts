import { describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ authedFetch: vi.fn(), operatorErrorMessage: (_s: number, m?: string) => m ?? 'Error' }));
import { authedFetch } from './api';
import {
  NO_NFC_EXIT_TEXT,
  canSkipPasskey,
  cashExitPlan,
  cashExitResult,
  exitNext,
  exitReasonText,
  fetchPayoutPlan,
  payoutPasskeyStatus,
  receptionCashPayout,
  requestPayoutPasskey,
} from './reception-cash-payout';
import type { ReceptionDeskSaldo } from './reception-desk';

const eur = (text: string | null) => (text ?? '').split(String.fromCharCode(160)).join(' ');
const view = (o: Partial<ReceptionDeskSaldo> = {}) => ({
  kind: 'saldo', walletId: 'wallet', code: 'R3D-8LP', balanceCents: 3_500, cashOutCents: 3_500, hasPin: true, hasPasskey: false,
  isHomeVenue: true, blocked: false, closeRequested: false, cashOutNote: null, fichaNumber: 388, printedNumber: '0388', ...o,
}) as ReceptionDeskSaldo;
const NFC = { card: 'token', uid: 'uid' };

describe('la salida (4.5)', () => {
  it('«Devolver 35 € en efectivo · Sacas 35 € de la caja · el NFC vuelve al stock»; guardar, lo de fábrica', () => {
    const plan = cashExitPlan(view(), NFC);
    expect(eur(plan.refundLabel)).toBe('Devolver 35 € en efectivo');
    expect(eur(plan.refundDetail)).toBe('Sacas 35 € de la caja · la ficha vuelve al stock');
    expect(plan.refundBlocked).toBeNull();
    expect(plan.keepDetail).toBe('Para otra noche · se lleva su ficha');
  });
  it('parte con tarjeta: lo exacto que sale de la caja y el resto, a su tarjeta', () => {
    const note = 'Los otros 15,00 € entraron con tarjeta: los devuelve el dueño «A la tarjeta».';
    const plan = cashExitPlan(view({ cashOutCents: 2_000, cashOutNote: note }), NFC);
    expect(eur(plan.refundLabel)).toBe('Devolver 20 € en efectivo');
    expect(eur(plan.refundDetail)).toBe('Sacas 20 € de la caja · los otros 15 € vuelven a su tarjeta');
    // Ya lo dice el botón; el del tope de 1.000 € en 24 h sí se enseña.
    expect(plan.note).toBeNull();
    const legal = 'En efectivo, como mucho 20,00 €: a este saldo ya se le devolvieron 980,00 € en efectivo en 24 h.';
    expect(cashExitPlan(view({ cashOutCents: 2_000, cashOutNote: legal }), NFC).note).toBe(legal);
    expect(note).toMatch(/^Los otros/);
  });
  it('sin efectivo que devolver no sale «Devolver 0 €»; solo guardar y por qué', () => {
    const plan = cashExitPlan(view({ cashOutCents: 0, cashOutNote: 'Este saldo entró con tarjeta.' }), NFC);
    expect(plan.refundLabel).toBeNull();
    expect(plan.refundBlocked).toBeNull();
    expect(plan.note).toBe('Este saldo entró con tarjeta.');
    expect(cashExitPlan(view({ balanceCents: 0, cashOutCents: 0 }), NFC)).toMatchObject({ refundLabel: null, note: null });
  });
  it('un saldo sin NFC (solo su código): lo devuelve el encargado en el panel; guardar dice «que guarde su código»', () => {
    const plan = cashExitPlan(view({ fichaNumber: null }), null);
    expect(plan.refundLabel).toBeNull();
    expect(plan.note).toBe(NO_NFC_EXIT_TEXT);
    expect(NO_NFC_EXIT_TEXT).toBe('Este saldo no tiene ficha: lo devuelve el encargado en el panel (Clientes → Saldos).');
    expect(plan.keepDetail).toBe('Para otra noche · que guarde su código');
  });
  it('para devolver: el NFC original con su número de serie y su PIN o su Face ID', () => {
    expect(cashExitPlan(view(), null).refundBlocked).toContain('ficha original');
    expect(cashExitPlan(view(), { card: 'token', uid: null }).refundBlocked).toContain('UID');
    expect(cashExitPlan(view({ hasPin: false }), NFC).refundBlocked).toContain('PIN');
    expect(cashExitPlan(view({ hasPin: false, hasPasskey: true }), NFC).refundBlocked).toBeNull();
    expect(cashExitPlan(view({ blocked: true }), NFC).refundBlocked).toMatch(/bloqueado/);
  });
});

describe('antes del PIN: qué hace falta', () => {
  it('su Face ID primero; si no, la 2FA del encargado, dejarlo al encargado o el PIN', () => {
    expect(exitNext({ needs: 'none', passkey: true })).toBe('passkey');
    expect(exitNext({ needs: 'manager_2fa', passkey: false })).toBe('totp');
    expect(exitNext({ needs: 'manager_pending', passkey: false })).toBe('manager');
    expect(exitNext({ needs: 'none', passkey: false })).toBe('pin');
    expect(eur(exitReasonText({ reasons: ['over_limit', 'night_cap'], nightCapCents: 30_000 }))).toBe('Más de 100 € · Pasas tu tope de la noche (300 €)');
    expect(canSkipPasskey('MANAGER')).toBe(true);
    expect(canSkipPasskey('WAITER')).toBe(false);
  });
});

describe('las respuestas y las llamadas', () => {
  it('hecho, pendiente del encargado, su 2FA o su Face ID', () => {
    const out = cashExitResult(200, JSON.stringify({ kind: 'manager', amountCents: 12000, message: 'confirm' }));
    expect(out.kind).toBe('manager');
    expect(out).not.toHaveProperty('refundedCents');
    expect(cashExitResult(200, '{"kind":"done","refundedCents":500,"remainingCents":0}').kind).toBe('done');
    expect(cashExitResult(403, '{"code":"TOTP_REQUIRED","message":"Tu 2FA"}')).toEqual({ kind: 'totp', message: 'Tu 2FA' });
    expect(cashExitResult(409, '{"code":"PAYOUT_PASSKEY_REQUIRED","message":"Face ID"}')).toEqual({ kind: 'passkey', message: 'Face ID' });
    expect(() => cashExitResult(409, '{"message":"Este saldo no tiene nada que devolver"}')).toThrow(/nada que devolver/);
  });
  it('manda NFC, PIN, el importe exacto y la misma clave al reintentar', async () => {
    vi.mocked(authedFetch).mockImplementation(async () => new Response('{"kind":"done","refundedCents":12000,"remainingCents":3000}'));
    const input = { card: 'token', uid: 'uid', pin: '1234', expectedAmountCents: 12000, requestKey: 'exit_same_attempt', totpCode: '123456' };
    await receptionCashPayout('wallet', input);
    await receptionCashPayout('wallet', input);
    expect(vi.mocked(authedFetch).mock.calls.slice(-2)).toEqual(Array(2).fill(['/v1/reception/wallets/wallet/payout', { method: 'POST', body: JSON.stringify(input) }]));
  });
  it('el plan, el QR del Face ID y si ya lo confirmó', async () => {
    vi.mocked(authedFetch).mockImplementation(async () => new Response('{"ok":true}'));
    await fetchPayoutPlan('w 1');
    await requestPayoutPasskey('w 1', { card: 'c', uid: 'u', expectedAmountCents: 1, requestKey: 'k' });
    await payoutPasskeyStatus('w 1', 'k');
    expect(vi.mocked(authedFetch).mock.calls.slice(-3).map((c) => c[0])).toEqual([
      '/v1/reception/wallets/w%201/payout/plan',
      '/v1/reception/wallets/w%201/payout/passkey',
      '/v1/reception/wallets/w%201/payout/passkey/k',
    ]);
    vi.mocked(authedFetch).mockImplementation(async () => new Response('{"message":"No"}', { status: 409 }));
    await expect(fetchPayoutPlan('w')).rejects.toThrow('No');
  });
});
