import { describe, expect, it } from 'vitest';
import { payoutAuthorisedBy, payoutNeeds, payoutReasonText } from './reception-payout-rules';

const base = { amountCents: 5_000, limitCents: 10_000, nightPaidCents: 0, nightCapCents: 30_000, hasPasskey: false, passkeyConfirmed: false };

describe('qué hace falta para una salida de recepción', () => {
  it('recepción: NFC + PIN hasta 100,00 € y dentro de su tope; si no, pendiente del encargado', () => {
    expect(payoutNeeds({ ...base, role: 'WAITER' })).toEqual({ needs: 'none', reasons: [] });
    expect(payoutNeeds({ ...base, role: 'WAITER', amountCents: 10_000 })).toEqual({ needs: 'none', reasons: [] });
    expect(payoutNeeds({ ...base, role: 'WAITER', amountCents: 10_001 })).toEqual({ needs: 'manager_pending', reasons: ['over_limit'] });
    expect(payoutNeeds({ ...base, role: 'WAITER', nightPaidCents: 25_001 })).toEqual({ needs: 'manager_pending', reasons: ['night_cap'] });
    expect(payoutNeeds({ ...base, role: 'WAITER', nightPaidCents: 25_000 })).toEqual({ needs: 'none', reasons: [] });
  });
  it('Face ID sin confirmar: recepción no puede (ni pendiente); confirmado, cuenta como el PIN', () => {
    expect(payoutNeeds({ ...base, role: 'WAITER', hasPasskey: true })).toEqual({ needs: 'passkey_required', reasons: ['no_passkey'] });
    expect(payoutNeeds({ ...base, role: 'WAITER', hasPasskey: true, passkeyConfirmed: true })).toEqual({ needs: 'none', reasons: [] });
    expect(payoutNeeds({ ...base, role: 'WAITER', hasPasskey: true, amountCents: 20_000 })).toMatchObject({ needs: 'passkey_required' });
  });
  it('el encargado: su 2FA por cualquiera de los motivos; el dueño, nada', () => {
    expect(payoutNeeds({ ...base, role: 'MANAGER' })).toEqual({ needs: 'none', reasons: [] });
    expect(payoutNeeds({ ...base, role: 'MANAGER', amountCents: 20_000, hasPasskey: true, nightPaidCents: 29_000 })).toEqual({
      needs: 'manager_2fa', reasons: ['over_limit', 'night_cap', 'no_passkey'],
    });
    expect(payoutNeeds({ ...base, role: 'OWNER', amountCents: 90_000, hasPasskey: true, nightPaidCents: 90_000 })).toEqual({ needs: 'none', reasons: [] });
  });
  it('el registro y los textos', () => {
    expect(payoutAuthorisedBy(false, false)).toEqual(['nfc_pin']);
    expect(payoutAuthorisedBy(true, true)).toEqual(['passkey', 'manager_2fa']);
    expect(payoutReasonText(['over_limit', 'night_cap'], 10_000, 30_000)).toBe('más de 100,00 € y pasa tu tope de la noche (300,00 €)');
    expect(payoutReasonText(['no_passkey'], 10_000, 30_000)).toMatch(/Face ID/);
  });
});
