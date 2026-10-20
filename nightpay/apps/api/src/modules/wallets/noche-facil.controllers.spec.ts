import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SaldoRefSchema, PendingTopUpStartSchema, type JwtPayload } from '@nightpay/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { NfcSchema, PosDeviceSaldoController } from '../pos-device/pos-device-saldo.controller';
import type { PosDevice } from '../pos-device/device.guard';
import { PendingTopUpsController } from './pending-topups.controller';
import { PayCardSchema, WalletChargesController } from './wallet-charges.controller';

/** Rutas de «Noche fácil»: siempre con el local y la persona (o el datáfono) de la sesión. */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const CHARGE = '6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a70';
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';
const lola = { sub: 'u-lola', role: 'OPERATOR', tenantId: SALA, email: 'lola@bambu.es' } as JwtPayload;
const device: PosDevice = { terminalId: 'term-barra', tenantId: SALA, label: 'Barra 1', zone: 'BARRA', tokenHash: 'h' };

describe('cuerpos de las peticiones', () => {
  it('NFC sin PIN en la app: su código grabado (y su número de serie si lo hay); en el datáfono, siempre con número de serie', () => {
    const app = new ZodValidationPipe(PayCardSchema);
    expect(app.transform({ card: FICHA })).toEqual({ card: FICHA });
    expect(app.transform({ card: FICHA, uid: '04:A2' })).toEqual({ card: FICHA, uid: '04:A2' });
    expect(() => app.transform({ card: 'https://evil.example/?x=1' })).toThrow(BadRequestException);
    const pax = new ZodValidationPipe(NfcSchema);
    expect(pax.transform({ card: FICHA, uid: '04A2' })).toEqual({ card: FICHA, uid: '04A2' });
    expect(() => pax.transform({ card: FICHA })).toThrow(BadRequestException);
  });

  it('el saldo por su NFC o por su código (uno solo); cobrar primero, con importe y clave', () => {
    const ref = new ZodValidationPipe(SaldoRefSchema);
    expect(ref.transform({ code: ' K7Q-4M2 ' })).toEqual({ code: 'K7Q-4M2' });
    expect(ref.transform({ card: FICHA, uid: '04A2' })).toEqual({ card: FICHA, uid: '04A2' });
    expect(() => ref.transform({ code: 'K7Q4M2', card: FICHA })).toThrow(BadRequestException);
    expect(() => ref.transform({})).toThrow(BadRequestException);
    const start = new ZodValidationPipe(PendingTopUpStartSchema);
    expect(start.transform({ amountCents: 5_000, idempotencyKey: 'rec-0001-abcd' })).toEqual({ amountCents: 5_000, idempotencyKey: 'rec-0001-abcd' });
    expect(() => start.transform({ amountCents: 0, idempotencyKey: 'rec-0001-abcd' })).toThrow(BadRequestException);
    expect(() => start.transform({ amountCents: 5_000 })).toThrow(BadRequestException);
  });
});

describe('controladores', () => {
  it('NFC sin PIN: la app con la persona de la sesión; el datáfono con su credencial', async () => {
    const charges = {
      payQrChargeWithCard: vi.fn(async () => ({ id: CHARGE, status: 'ACCEPTED' })),
      payQrChargeFromTerminalWithCard: vi.fn(async () => ({ id: CHARGE, status: 'ACCEPTED' })),
    };
    const app = new WalletChargesController(charges as never, { get: vi.fn() } as never);
    await app.payWithCard(lola, CHARGE, { card: FICHA });
    expect(charges.payQrChargeWithCard).toHaveBeenCalledWith({ userId: 'u-lola', role: 'OPERATOR', tenantId: SALA }, CHARGE, {
      card: FICHA,
      uid: null,
    });
    const pax = new PosDeviceSaldoController(charges as never);
    await pax.nfc(device, CHARGE, { card: FICHA, uid: '04A2' });
    expect(charges.payQrChargeFromTerminalWithCard).toHaveBeenCalledWith(device, CHARGE, { card: FICHA, uid: '04A2' });
  });

  it('recargas pendientes de asignar: cobrar, ver y asignar con la persona y el local de la sesión', async () => {
    const pending = {
      start: vi.fn(async () => ({ id: 'pay-1' })),
      list: vi.fn(async () => []),
      assign: vi.fn(async () => ({ walletId: WALLET })),
    };
    const ctrl = new PendingTopUpsController(pending as never);
    const actor = { userId: 'u-lola', role: 'OPERATOR', tenantId: SALA };
    await ctrl.start(lola, { amountCents: 5_000, idempotencyKey: 'rec-0001-abcd' });
    expect(pending.start).toHaveBeenCalledWith(actor, { amountCents: 5_000, idempotencyKey: 'rec-0001-abcd' });
    await ctrl.list(lola);
    expect(pending.list).toHaveBeenCalledWith(actor);
    await ctrl.assign(lola, WALLET, { code: 'K7Q4M2' });
    expect(pending.assign).toHaveBeenCalledWith(actor, WALLET, { code: 'K7Q4M2' });
  });
});
