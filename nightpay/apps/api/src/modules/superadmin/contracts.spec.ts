import { describe, it, expect } from 'vitest';
import {
  AuditListQuerySchema,
  CreateStaffUserSchema,
  CreateVenueSchema,
  SetSettlementAccountSchema,
  UpdatePayoutAccountSchema,
  UpdateVenueProfileSchema,
  UpdateVenueRulesSchema,
  commissionTotalsProblem,
  isValidSettlementIban,
  normalizeTaxId,
  CreateBusinessSchema,
} from '@nightpay/contracts';

const TOTP = { totpCode: '123 456' };
const REASON = 'cambio pedido por el dueño';
const IBAN_OK = 'ES91 2100 0418 4502 0005 1332';

describe('contratos del super-admin — validadores', () => {
  it('IBAN de liquidación: mod-97, se guarda sin espacios y en mayúsculas', () => {
    expect(isValidSettlementIban(IBAN_OK)).toBe(true);
    expect(isValidSettlementIban('ES91 2100 0418 4502 0005 1333')).toBe(false);
    const ok = SetSettlementAccountSchema.parse({ iban: 'es91 2100 0418 4502 0005 1332', holder: 'Luna Ocio SL', ...TOTP });
    expect(ok).toEqual({ iban: 'ES9121000418450200051332', holder: 'Luna Ocio SL', totpCode: '123456' });
    expect(SetSettlementAccountSchema.safeParse({ iban: 'ES00 1234', holder: 'X SL', ...TOTP }).success).toBe(false);
    // Sin 2FA no vale.
    expect(SetSettlementAccountSchema.safeParse({ iban: IBAN_OK, holder: 'X SL' }).success).toBe(false);
  });

  it('cuenta de cobro de la chica según el método: TRC20, EVM, Solana, IBAN y email', () => {
    // Con titular: en SEPA y SWIFT es obligatorio (ver abajo).
    const payoutMetadata = { accountHolder: 'Ana López' };
    const ok = (payoutMethod: string, payoutAddress: string) =>
      UpdatePayoutAccountSchema.safeParse({ payoutMethod, payoutAddress, payoutMetadata, reason: REASON, ...TOTP }).success;
    expect(ok('USDT_TRC20', 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV')).toBe(true);
    expect(ok('USDT_TRC20', '0x55d398326f99059ff775485246999027b3197955')).toBe(false);
    expect(ok('USDT_BEP20', '0x55d398326f99059ff775485246999027b3197955')).toBe(true);
    expect(ok('USDC_POLY', '0x55d3')).toBe(false);
    expect(ok('USDC_SOL', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBe(true);
    expect(ok('USDC_SOL', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl')).toBe(false);
    expect(ok('SEPA_IBAN', IBAN_OK)).toBe(true);
    expect(ok('SEPA_IBAN', 'ES91 2100 0418 4502 0005 1333')).toBe(false);
    expect(ok('PAYONEER_EMAIL', 'ana@gmail.com')).toBe(true);
    expect(ok('PAYONEER_EMAIL', 'ana-at-gmail')).toBe(false);
    // IBAN SEPA sin titular, no.
    expect(UpdatePayoutAccountSchema.safeParse({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN_OK, reason: REASON, ...TOTP }).success).toBe(false);
  });

  it('cuenta de cobro: método y cuenta juntos (o los dos null para quitarla); motivo obligatorio', () => {
    const base = { reason: REASON, ...TOTP };
    expect(UpdatePayoutAccountSchema.safeParse({ ...base, payoutMethod: null, payoutAddress: null }).success).toBe(true);
    expect(UpdatePayoutAccountSchema.safeParse({ ...base, payoutMethod: 'SEPA_IBAN', payoutAddress: null }).success).toBe(false);
    expect(
      UpdatePayoutAccountSchema.safeParse({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN_OK, ...TOTP }).success,
    ).toBe(false);
  });

  it('reglas del local: rangos (días 0–60, comisiones 0–100 %, tope ≤ 10.000 €) y 2FA', () => {
    const ok = (rules: Record<string, unknown>) => UpdateVenueRulesSchema.safeParse({ ...rules, ...TOTP }).success;
    expect(ok({ payoutHoldDays: 0 })).toBe(true);
    expect(ok({ payoutHoldDays: 60 })).toBe(true);
    expect(ok({ payoutHoldDays: null })).toBe(true);
    expect(ok({ payoutHoldDays: 61 })).toBe(false);
    expect(ok({ payoutHoldDays: -1 })).toBe(false);
    expect(ok({ payoutHoldDays: 1.5 })).toBe(false);
    expect(ok({ platformCommissionBps: 10_001 })).toBe(false);
    expect(ok({ operatorCommissionDefaults: { CHICA_SERVICE: 10_001 } })).toBe(false);
    expect(ok({ operatorMaxCobroCents: 10_000_01 })).toBe(false);
    expect(ok({ refundApprovalThresholdCents: -1 })).toBe(false);
    expect(ok({})).toBe(false); // nada que cambiar
    expect(UpdateVenueRulesSchema.safeParse({ payoutHoldDays: 0 }).success).toBe(false); // sin 2FA
  });

  it('suma de comisiones: chica + plataforma ≤ 100 %', () => {
    expect(commissionTotalsProblem({ platformCommissionBps: 1000, operatorCommissionDefaults: { CHICA_SERVICE: 9000 } })).toBeNull();
    expect(commissionTotalsProblem({ platformCommissionBps: 1001, operatorCommissionDefaults: { CHICA_SERVICE: 9000 } })).toMatch(/100 %/);
  });

  it('perfil del local: zona horaria IANA y grupo del saldo en minúsculas', () => {
    expect(UpdateVenueProfileSchema.safeParse({ timezone: 'Europe/Madrid' }).success).toBe(true);
    expect(UpdateVenueProfileSchema.safeParse({ timezone: 'Marte/Olympus' }).success).toBe(false);
    expect(UpdateVenueProfileSchema.safeParse({ walletGroup: 'luna', ...TOTP }).success).toBe(true);
    expect(UpdateVenueProfileSchema.safeParse({ walletGroup: 'Luna Grupo' }).success).toBe(false);
    expect(UpdateVenueProfileSchema.safeParse({ totpCode: '123456' }).success).toBe(false);
    expect(CreateVenueSchema.safeParse({ name: 'Luna', slug: 'Luna VLC' }).success).toBe(false);
  });

  it('negocio: NIF/CIF normalizado; alta de personal con reglas por rol', () => {
    expect(normalizeTaxId(' b-12.345.678 ')).toBe('B12345678');
    expect(CreateBusinessSchema.parse({ name: 'Luna Ocio SL', taxId: 'b-12345678' }).taxId).toBe('B12345678');
    expect(CreateBusinessSchema.safeParse({ name: 'X', taxId: '1' }).success).toBe(false);
    const venueId = '0b6f4a8e-6f1e-4e0b-9a51-0c2f3c4d5e6f';
    expect(CreateStaffUserSchema.safeParse({ venueId, role: 'MANAGER', email: 'Ana@X.es', ...TOTP }).success).toBe(true);
    expect(CreateStaffUserSchema.parse({ venueId, role: 'MANAGER', email: 'Ana@X.es', ...TOTP }).email).toBe('ana@x.es');
    expect(CreateStaffUserSchema.safeParse({ venueId, role: 'MANAGER', email: 'a@x.es', commissionBps: 100, ...TOTP }).success).toBe(false);
    expect(CreateStaffUserSchema.safeParse({ venueId, role: 'OPERATOR', email: 'a@x.es', ...TOTP }).success).toBe(false);
    expect(CreateStaffUserSchema.safeParse({ venueId, role: 'OPERATOR', email: 'a@x.es', displayName: 'Ana', ...TOTP }).success).toBe(true);
  });

  it('registro: el cursor cabe en la base (hasta 18 cifras); uno enorme da 400, no un 500 (punto 75)', () => {
    expect(AuditListQuerySchema.safeParse({ cursor: '9999999999999999999' }).success).toBe(false);
    expect(AuditListQuerySchema.parse({ cursor: '999999999999999999' }).cursor).toBe('999999999999999999');
  });
});
