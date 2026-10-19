import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { PosDevice } from './device.guard';
import { PinSchema, PosDeviceSaldoController, RefSchema, refOf } from './pos-device-saldo.controller';

const FICHA = 'Kp3vX9qL2mN8rT5wYb7c';
const PASE = 'pase-google-wallet-del-saldo-0001';
const CHARGE = '6f1d2c3b-4a59-4e7f-8a1b-2c3d4e5f6a70';

const device: PosDevice = { terminalId: 'term-barra', tenantId: 'sala', label: 'Barra 1', zone: 'BARRA', tokenHash: 'h' };

describe('cuerpo de las peticiones del saldo en el datáfono', () => {
  const ref = new ZodValidationPipe(RefSchema);
  const pin = new ZodValidationPipe(PinSchema);

  it('una sola forma de decir el saldo: la ficha (con su número de serie), el pase o el código', () => {
    expect(ref.transform({ card: FICHA, uid: '04:A2:3B:1C' })).toEqual({ card: FICHA, uid: '04:A2:3B:1C' });
    expect(ref.transform({ walletToken: PASE })).toEqual({ walletToken: PASE });
    expect(ref.transform({ code: ' K7Q-4M2 ' })).toEqual({ code: 'K7Q-4M2' });
    expect(() => ref.transform({})).toThrow(BadRequestException);
    expect(() => ref.transform({ code: 'K7Q4M2', card: FICHA })).toThrow(BadRequestException);
    expect(() => ref.transform({ card: 'https://evil.example/?x=1' })).toThrow(BadRequestException);
  });

  it('el PIN son 4 cifras y va con una forma de decir el saldo', () => {
    expect(pin.transform({ walletToken: PASE, pin: '4827' })).toEqual({ walletToken: PASE, pin: '4827' });
    expect(() => pin.transform({ walletToken: PASE, pin: '48a7' })).toThrow(BadRequestException);
    expect(() => pin.transform({ pin: '4827' })).toThrow(BadRequestException);
  });

  it('refOf: la ficha lleva su número de serie (o null); el resto, tal cual', () => {
    expect(refOf({ card: FICHA })).toEqual({ card: FICHA, uid: null });
    expect(refOf({ card: FICHA, uid: '04A2' })).toEqual({ card: FICHA, uid: '04A2' });
    expect(refOf({ walletToken: PASE })).toEqual({ walletToken: PASE });
    expect(refOf({ code: 'K7Q4M2' })).toEqual({ code: 'K7Q4M2' });
  });
});

describe('PosDeviceSaldoController', () => {
  it('pasa el datáfono (su local) al servicio, nunca un local que venga en la petición', async () => {
    const charges = {
      pendingQrChargesForTerminal: vi.fn(async () => []),
      qrChargeForTerminal: vi.fn(async () => ({ id: CHARGE })),
      qrChargeStatusForTerminal: vi.fn(async () => ({ id: CHARGE, status: 'PENDING' })),
      checkWalletForTerminal: vi.fn(async () => ({ enough: true })),
      payQrChargeFromTerminal: vi.fn(async () => ({ id: CHARGE, status: 'ACCEPTED' })),
    };
    const ctrl = new PosDeviceSaldoController(charges as never);
    await ctrl.list(device);
    await ctrl.scan(device, { payToken: 'qr-del-cobro-numero-1' });
    await ctrl.status(device, CHARGE);
    await ctrl.check(device, CHARGE, { card: FICHA, uid: '04A2' });
    await ctrl.pin(device, CHARGE, { code: 'K7Q4M2', pin: '4827' });
    expect(charges.pendingQrChargesForTerminal).toHaveBeenCalledWith(device);
    expect(charges.qrChargeForTerminal).toHaveBeenCalledWith(device, 'qr-del-cobro-numero-1');
    expect(charges.qrChargeStatusForTerminal).toHaveBeenCalledWith(device, CHARGE);
    expect(charges.checkWalletForTerminal).toHaveBeenCalledWith(device, CHARGE, { card: FICHA, uid: '04A2' });
    expect(charges.payQrChargeFromTerminal).toHaveBeenCalledWith(device, CHARGE, { code: 'K7Q4M2', pin: '4827' });
  });
});
