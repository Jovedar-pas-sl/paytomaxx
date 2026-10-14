import { describe, it, expect, vi, beforeAll } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin } from './wallet-pin';

/**
 * Cobrar del saldo con el PIN del cliente: el PIN decide si se cobra; 5
 * fallos seguidos bloquean el saldo hasta que lo desbloquee el encargado.
 * (La parte que cobra es la misma que "Aceptar" y tiene sus propias pruebas.)
 */

const PEPPER = 'clave-del-servidor-para-las-pruebas-0123456789';
let STORED: string;

beforeAll(async () => {
  process.env.ENCRYPTION_KEK = PEPPER;
  STORED = await hashPin('4827', PEPPER);
});

type Row = { pinHash: string | null; pinFails: number; pinLockedAt: Date | null };

function makeService(row: Row) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ ...row }]),
    clientWallet: {
      update: vi.fn(async ({ data }: { data: Partial<Row> }) => Object.assign(row, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { pinHash: null }; data: Partial<Row> }) => {
        if (where.pinHash === null && row.pinHash !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    walletChargeRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async () => undefined) };
  const svc = new WalletChargesService(prisma as never, audit as never, {} as never);
  const internals = svc as unknown as Record<string, unknown>;
  internals.walletFor = vi.fn(async () => ({ id: 'wallet-1', tenantId: 'venue-1' }));
  internals.walletByToken = vi.fn(async () => ({ id: 'wallet-1', tenantId: 'venue-1' }));
  internals.lookupWallet = vi.fn(async () => ({ hasPin: row.pinHash !== null }));
  const openRequest = vi.fn(async () => ({ id: 'req-1' }));
  const settleRequest = vi.fn(async () => undefined);
  internals.openRequest = openRequest;
  internals.settleRequest = settleRequest;
  internals.getRequest = vi.fn(async () => ({ id: 'req-1', status: 'ACCEPTED', newBalanceCents: 4000 }));
  return { svc, row, openRequest, settleRequest, audit };
}

const actor = { userId: 'chica-1', role: 'OPERATOR' as const, tenantId: 'venue-1' };
const charge = (pin: string) => ({ code: 'K7Q4M2', serviceItemId: 'svc-1', pin });

describe('cobrar del saldo con el PIN del cliente', () => {
  it('PIN bueno → se cobra al momento', async () => {
    const { svc, settleRequest } = makeService({ pinHash: STORED, pinFails: 0, pinLockedAt: null });
    await expect(svc.chargeWithPin(actor, charge('4827'))).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect(settleRequest).toHaveBeenCalledWith('wallet-1', 'req-1');
  });

  it('PIN malo → no se cobra, dice cuántos intentos quedan; el bueno pone el contador a 0', async () => {
    const { svc, row, openRequest } = makeService({ pinHash: STORED, pinFails: 0, pinLockedAt: null });
    await expect(svc.chargeWithPin(actor, charge('1111'))).rejects.toThrow('PIN incorrecto. Quedan 4 intentos');
    await expect(svc.chargeWithPin(actor, charge('2222'))).rejects.toThrow('Quedan 3 intentos');
    expect(openRequest).not.toHaveBeenCalled();
    expect(row.pinFails).toBe(2);
    await svc.chargeWithPin(actor, charge('4827'));
    expect(row.pinFails).toBe(0);
  });

  it('el 5º fallo bloquea el saldo; bloqueado, ni con el PIN bueno; el encargado lo desbloquea', async () => {
    const { svc, row, settleRequest } = makeService({ pinHash: STORED, pinFails: 3, pinLockedAt: null });
    await expect(svc.chargeWithPin(actor, charge('0001'))).rejects.toThrow('Queda 1 intento');
    await expect(svc.chargeWithPin(actor, charge('0002'))).rejects.toThrow(/Saldo bloqueado/);
    expect(row.pinLockedAt).toBeInstanceOf(Date);
    await expect(svc.chargeWithPin(actor, charge('4827'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(settleRequest).not.toHaveBeenCalled();

    // La chica no puede desbloquear; el encargado sí.
    (svc as unknown as Record<string, unknown>).managerWallet = vi.fn(async (a: { role: string }) => {
      if (a.role !== 'MANAGER' && a.role !== 'OWNER') throw new ForbiddenException('Solo el encargado o el dueño');
    });
    await expect(svc.unlockPin(actor, 'wallet-1')).rejects.toBeInstanceOf(ForbiddenException);
    await svc.unlockPin({ ...actor, role: 'MANAGER' }, 'wallet-1');
    expect(row).toMatchObject({ pinFails: 0, pinLockedAt: null });
    await expect(svc.chargeWithPin(actor, charge('4827'))).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('sin PIN aún → hay que elegirlo antes de cobrar', async () => {
    const { svc } = makeService({ pinHash: null, pinFails: 0, pinLockedAt: null });
    await expect(svc.chargeWithPin(actor, charge('4827'))).rejects.toBeInstanceOf(ConflictException);
  });

  it('elegir PIN: uno solo (cambiarlo es cosa del encargado), y nada de PIN obvios', async () => {
    const { svc, row } = makeService({ pinHash: null, pinFails: 0, pinLockedAt: null });
    await expect(svc.setPin(actor, { code: 'K7Q4M2', pin: '1234' })).rejects.toBeInstanceOf(BadRequestException);
    await svc.setPin(actor, { code: 'K7Q4M2', pin: '4827' });
    expect(row.pinHash).toMatch(/^s1\$/);
    expect(row.pinHash).not.toContain('4827');
    await expect(svc.setPin(actor, { code: 'K7Q4M2', pin: '5931' })).rejects.toThrow('Este saldo ya tiene PIN');
    await expect(svc.setPinByWalletToken('tok', '5931')).rejects.toThrow('Este saldo ya tiene PIN');
  });

  it('si no se puede cobrar (saldo, cerrado…) el cobro no queda pendiente', async () => {
    const { svc, settleRequest } = makeService({ pinHash: STORED, pinFails: 0, pinLockedAt: null });
    settleRequest.mockRejectedValueOnce(new ConflictException('No hay saldo suficiente para este cobro'));
    await expect(svc.chargeWithPin(actor, charge('4827'))).rejects.toThrow('No hay saldo suficiente');
  });
});
