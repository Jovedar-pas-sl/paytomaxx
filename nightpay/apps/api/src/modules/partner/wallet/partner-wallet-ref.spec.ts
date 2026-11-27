import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { WALLET_REF_DETAIL } from '@nightpay/contracts';
import { PartnerHttpException } from '../http/partner-problem';
import { PartnerWalletRefs, classifyWalletRef, walletReachable } from './partner-wallet-ref';

/**
 * La forma del `qr` (A2 del encargo y `Qr` del contrato): pura, sin lanzar
 * nunca, y el rechazo depende solo de la forma del texto.
 */

const LINK = 'demoPrivateLink000000001';

describe('classifyWalletRef: los textos de muestra del contrato (Fixture)', () => {
  it.each([
    ['https://demo-api.oxiopay.example/c/demoGoogleWalletPass00000000000000000000001', 'wallet_pass'],
    [`https://demo-api.oxiopay.example/w/${LINK}`, 'private_link'],
    ['NPF:K7Q4M2:demoReceptionProof0001', 'reception_qr'],
    ['K7Q4M2', 'short_code'],
    ['https://demo-api.oxiopay.example/pay/demoChargeLink000000000000000001', 'charge_link'],
    ['https://demo-api.oxiopay.example/w/a/demoActivationLink000001', 'other_link'],
  ])('%s → wallet_ref_not_accepted (%s)', (qr, reason) => {
    expect(classifyWalletRef(qr)).toMatchObject({ kind: 'rejected', reason });
  });

  it('https://example.org/carta → sin reconocer', () => {
    expect(classifyWalletRef('https://example.org/carta')).toEqual({ kind: 'unrecognized' });
  });

  it('el ejemplo OXC1 del contrato → código; la ficha del ejemplo → ficha', () => {
    expect(classifyWalletRef('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9')).toEqual({ kind: 'live_code', code: 'OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9' });
    expect(classifyWalletRef('https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001')).toEqual({
      kind: 'ficha',
      token: 'demo-ficha-uid-0000001',
    });
  });
});

describe('classifyWalletRef: los bordes', () => {
  it('una ficha de otro host también es ficha', () => {
    expect(classifyWalletRef('https://otro.example/?ficha=demo-ficha-active-0001')).toEqual({ kind: 'ficha', token: 'demo-ficha-active-0001' });
  });

  it('http:, ftp: o sin esquema → sin reconocer', () => {
    expect(classifyWalletRef('http://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001')).toEqual({ kind: 'unrecognized' });
    expect(classifyWalletRef('ftp://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001')).toEqual({ kind: 'unrecognized' });
    expect(classifyWalletRef('hola')).toEqual({ kind: 'unrecognized' });
    expect(classifyWalletRef('')).toEqual({ kind: 'unrecognized' });
  });

  it('un tramo codificado (%77 = w) → enlace privado; un % suelto, sin reconocer y sin lanzar', () => {
    expect(classifyWalletRef('https://h/%77/abcdefghijklmnopqrstuvwx')).toEqual({
      kind: 'rejected',
      reason: 'private_link',
      privateLink: 'abcdefghijklmnopqrstuvwx',
    });
    expect(() => classifyWalletRef('https://h/%/x')).not.toThrow();
    expect(classifyWalletRef('https://h/%/x')).toEqual({ kind: 'unrecognized' });
    expect(classifyWalletRef('https://h/w/%E0%A4%A')).toEqual({ kind: 'unrecognized' });
    expect(() => classifyWalletRef('https://[::1')).not.toThrow();
  });

  it('minúsculas y espacios alrededor: el mismo código en mayúsculas', () => {
    expect(classifyWalletRef('  oxc1:k3j7q2m9x4t8r6v1n5b0c2d7f9 \n')).toEqual({ kind: 'live_code', code: 'OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9' });
  });

  it('OXC1: de 25, con I o con U → código mal formado (live_code_invalid)', () => {
    expect(classifyWalletRef('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F')).toEqual({ kind: 'live_code_malformed' });
    expect(classifyWalletRef('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7FI')).toEqual({ kind: 'live_code_malformed' });
    expect(classifyWalletRef('OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7FU')).toEqual({ kind: 'live_code_malformed' });
  });

  it('ОXC1 con la О cirílica → sin reconocer', () => {
    expect(classifyWalletRef('ОXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9')).toEqual({ kind: 'unrecognized' });
  });

  it('el enlace privado con ?ficha= sigue siendo enlace privado', () => {
    expect(classifyWalletRef(`https://h/w/${LINK}?ficha=demo-ficha-uid-0000001`)).toMatchObject({ kind: 'rejected', reason: 'private_link', privateLink: LINK });
  });

  it('las demás de /w/… y los enlaces de reservas y regalos → other_link', () => {
    for (const path of ['w/a/demoActivationLink000001', 'w/card/demo-ficha-uid-0000001', 'w/salida/x', 'w/no/x', 'w/mine', 'w', 'r/LOCAL1', 'r/regalo/x', 'reservar/LOCAL1', 'reservas/x']) {
      expect(classifyWalletRef(`https://h/${path}`), path).toMatchObject({ kind: 'rejected', reason: 'other_link' });
    }
    expect(classifyWalletRef('https://h/w/a/x').kind === 'rejected' && 'privateLink' in classifyWalletRef('https://h/w/a/x')).toBe(false);
  });

  it('/s/… y /pay/… → charge_link; /c/… → wallet_pass; ?saldo= y el código con guion o espacio → short_code', () => {
    expect(classifyWalletRef('https://h/s/x')).toMatchObject({ reason: 'charge_link' });
    expect(classifyWalletRef('https://h/c/x')).toMatchObject({ reason: 'wallet_pass' });
    expect(classifyWalletRef('https://operator.h/?saldo=K7Q4M2')).toMatchObject({ reason: 'short_code' });
    expect(classifyWalletRef('K7Q-4M2')).toMatchObject({ reason: 'short_code' });
    expect(classifyWalletRef('k7q 4m2')).toMatchObject({ reason: 'short_code' });
    expect(classifyWalletRef('K7Q4M2X')).toEqual({ kind: 'unrecognized' });
  });

  it('el detail de cada reason', () => {
    expect(WALLET_REF_DETAIL.private_link).toEqual({
      en: 'This is the customer\'s private wallet link and it is never accepted. Ask for the code under "Pagar o recargar en otro sistema".',
      es: 'Es el enlace privado del saldo del cliente y nunca se acepta. Pide el código de «Pagar o recargar en otro sistema».',
    });
    expect(WALLET_REF_DETAIL.wallet_pass.en).toBe('This is the customer\'s Google Wallet pass and it is never accepted. Ask for the code under "Pagar o recargar en otro sistema".');
    expect(WALLET_REF_DETAIL.wallet_pass.es).toBe('Es el pase de Google Wallet del cliente y nunca se acepta. Pide el código de «Pagar o recargar en otro sistema».');
    expect(WALLET_REF_DETAIL.reception_qr.es).toBe('Es el QR de recepción y nunca se acepta. Pide el código de «Pagar o recargar en otro sistema».');
    expect(WALLET_REF_DETAIL.short_code.en).toMatch(/^This is the 6-character wallet code and/);
    expect(WALLET_REF_DETAIL.charge_link.es).toMatch(/^Es el enlace de un cobro y/);
    expect(WALLET_REF_DETAIL.other_link.en).toMatch(/^This is an OxioPay link that is not a wallet and/);
  });

  it('un enlace privado no llega a ningún Logger ni a console', () => {
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => vi.spyOn(Logger.prototype, m)),
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => vi.spyOn(Logger, m)),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m)),
    ];
    classifyWalletRef(`https://h/w/${LINK}`);
    classifyWalletRef('https://h/%/x');
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});

describe('walletReachable: el alcance de una clave', () => {
  const conn = { tenantId: 'A', walletGroup: 'G', businessId: 'X' };
  it('mismo local, o mismo grupo y origen de la misma sociedad → sí', () => {
    expect(walletReachable({ tenantId: 'A', walletGroup: 'G' }, { businessId: 'X' }, conn)).toBe(true);
    expect(walletReachable({ tenantId: 'A2', walletGroup: 'G' }, { businessId: 'X' }, conn)).toBe(true);
  });
  it('otra sociedad, origen sin sociedad u otro grupo → no', () => {
    expect(walletReachable({ tenantId: 'A3', walletGroup: 'G' }, { businessId: 'Y' }, conn)).toBe(false);
    expect(walletReachable({ tenantId: 'A4', walletGroup: 'G' }, { businessId: null }, conn)).toBe(false);
    expect(walletReachable({ tenantId: 'B', walletGroup: 'H' }, { businessId: 'X' }, conn)).toBe(false);
  });
  it('un regalo (saldo de otro local sin grupo) → no; el mismo local sin sociedad → no', () => {
    expect(walletReachable({ tenantId: 'A2', walletGroup: null }, { businessId: 'X' }, conn)).toBe(false);
    expect(walletReachable({ tenantId: 'A', walletGroup: 'G' }, { businessId: null }, { ...conn, businessId: 'X' })).toBe(false);
  });
});

describe('PartnerWalletRefs: una ficha copiada', () => {
  const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
  const WALLET = 'bbbbbbbb-0000-0000-0000-000000000001';
  const auth = { connection: { id: 'cccccccc-0000-0000-0000-000000000001', tenantId: TENANT, partner: { name: 'Cajeros Demo' } }, keyHint: 'oxp_test_…aaaa' };

  function refs(audit: { log: ReturnType<typeof vi.fn> }) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ mergedIntoId: null }]),
      walletCard: { findUnique: vi.fn(async () => ({ id: 'card-1', status: 'ISSUED', walletId: WALLET, uid: '04AABBCCDD' })) },
      clientWallet: {
        findUnique: vi.fn(async () => ({ id: WALLET, tenantId: TENANT, walletGroup: null, balanceCents: 1000, status: 'ACTIVE', blockedAt: null, shortCode: null })),
      },
      venue: { findUnique: vi.fn(async () => ({ businessId: 'eeeeeeee-0000-0000-0000-000000000001', walletGroup: null })) },
    };
    const prisma = { asSystem: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
    const redis = { set: vi.fn(async () => 'OK') };
    return new PartnerWalletRefs(prisma as never, {} as never, {} as never, audit as never, redis as never);
  }

  it('si el registro falla, el cajero recibe igual ficha_copy_suspected (no un 500)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const audit = { log: vi.fn(async () => Promise.reject(new Error('SELECT secreto de audit_events'))) };
    const err = await refs(audit)
      .resolve(auth as never, { qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001', nfc_uid: '04:11:22:33:44' } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartnerHttpException);
    expect((err as PartnerHttpException).code).toBe('ficha_copy_suspected');
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(Error)'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('secreto'));
    warn.mockRestore();
  });
});
