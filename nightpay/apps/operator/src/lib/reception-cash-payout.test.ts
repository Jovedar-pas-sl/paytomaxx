import { describe, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ authedFetch: vi.fn() }));
import { authedFetch } from './api';
import { cashExitPlan, cashExitResult, receptionCashPayout } from './reception-cash-payout';
import type { ReceptionDeskSaldo } from './reception-desk';

const view = { walletId: 'wallet', balanceCents: 15000, cashOutCents: 12000, hasPin: true, cashOutNote: null } as ReceptionDeskSaldo;
describe('reception NFC cash exit', () => {
  it('requires the original NFC, its UID and an existing customer PIN', () => {
    expect(cashExitPlan(view, null).refundBlocked).toContain('NFC original');
    expect(cashExitPlan(view, { card: 'token', uid: null }).refundBlocked).toContain('UID');
    expect(cashExitPlan({ ...view, hasPin: false }, { card: 'token', uid: 'uid' }).refundBlocked).toContain('PIN');
    expect(cashExitPlan(view, { card: 'token', uid: 'uid' }).refundBlocked).toBeNull();
  });
  it('keeps manager pending separate from a completed refund', () => {
    const out = cashExitResult(200, JSON.stringify({ kind: 'manager', amountCents: 12000, message: 'confirm' }));
    expect(out.kind).toBe('manager');
    expect(out).not.toHaveProperty('refundedCents');
    expect(cashExitResult(200, '{"kind":"done","refundedCents":500,"remainingCents":0}').kind).toBe('done');
    expect(cashExitResult(403, '{"code":"TOTP_REQUIRED","message":"Tu 2FA"}').kind).toBe('totp');
  });
  it('sends NFC + PIN, exact cash amount and the same request key on retry', async () => {
    vi.mocked(authedFetch).mockImplementation(async () => new Response('{"kind":"done","refundedCents":12000,"remainingCents":3000}'));
    const input = { card: 'token', uid: 'uid', pin: '1234', expectedAmountCents: 12000, requestKey: 'exit_same_attempt', totpCode: '123456' };
    await receptionCashPayout('wallet', input);
    await receptionCashPayout('wallet', input);
    expect(vi.mocked(authedFetch).mock.calls.slice(-2)).toEqual(Array(2).fill(['/v1/reception/wallets/wallet/payout', { method: 'POST', body: JSON.stringify(input) }]));
  });
});
