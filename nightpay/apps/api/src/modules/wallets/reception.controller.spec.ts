import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '@nightpay/contracts';
import { STAFF_PERMISSION_KEY } from '../venues/staff-permission.guard';
import { PosDeviceReceptionController } from '../pos-device/pos-device-reception.controller';
import { sha256 } from '../pos-device/paytef';
import type { PosDevice } from '../pos-device/device.guard';
import { ReceptionController } from './reception.controller';
import { WalletCardsController } from './wallet-cards.controller';

/**
 * Las rutas de la recepción (app del personal y datáfono) y de Clientes →
 * Fichas: quién las llama, qué permiso piden y a qué servicio van.
 */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const user = { sub: 'u-1', role: 'WAITER', tenantId: SALA } as JwtPayload;
const device: PosDevice = { terminalId: 'term-recepcion', tenantId: SALA, label: 'Recepción', zone: null, tokenHash: sha256('x') };
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';

function services(venue: Record<string, unknown> = {}) {
  const cash = { topUp: vi.fn().mockResolvedValue({ walletId: 'w' }), cashBlockedReason: vi.fn().mockResolvedValue(null) };
  const cards = {
    newStockToken: vi.fn().mockResolvedValue({ card: FICHA }),
    stock: vi.fn().mockResolvedValue({ outcome: 'stocked' }),
    list: vi.fn().mockResolvedValue([]),
    summary: vi.fn().mockResolvedValue({ enStock: 0, entregadas: 0, nights: [] }),
    mark: vi.fn().mockResolvedValue({ id: 'c' }),
    desk: vi.fn().mockResolvedValue({ kind: 'new', fichaNumber: 522 }),
  };
  const charges = {
    lookupCardForReception: vi.fn().mockResolvedValue({ walletId: 'w' }),
    lookupForReception: vi.fn().mockResolvedValue({ walletId: 'w' }),
    receptionWallet: vi.fn().mockResolvedValue({ walletId: 'w' }),
    linkCardFromTerminal: vi.fn().mockResolvedValue({ walletId: 'w' }),
    setPinFromTerminal: vi.fn().mockResolvedValue({ walletId: 'w' }),
  };
  const tx = { venue: { findUnique: vi.fn().mockResolvedValue({ paymentMethods: null, pausedAt: null, business: null, ...venue }) } };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const reception = { options: vi.fn().mockResolvedValue({}), cashTopUp: vi.fn(), cardTopUp: vi.fn() };
  return { cash, cards, charges, prisma, reception };
}

describe('recepción desde la app del personal', () => {
  it('opciones: con tarjeta es el QR de la recarga (tarjeta + saldo); el efectivo, según el permiso', async () => {
    const s = services();
    const ctrl = new ReceptionController(s.cash as never, s.cards as never, s.charges as never, s.prisma as never);
    await expect(ctrl.options(user)).resolves.toEqual({ card: true, cash: true, cashBlockedReason: null, nfc: true });
    expect(s.cash.cashBlockedReason).toHaveBeenCalledWith(SALA, { userId: 'u-1', role: 'WAITER' });
    const off = services({ paymentMethods: { card: false, nfc: false } });
    off.cash.cashBlockedReason.mockResolvedValue('El dueño del local no te deja cobrar recargas en efectivo.');
    const ctrlOff = new ReceptionController(off.cash as never, off.cards as never, off.charges as never, off.prisma as never);
    await expect(ctrlOff.options(user)).resolves.toMatchObject({ card: false, cash: false, nfc: false });
  });

  it('cobrar en efectivo: el puesto y el permiso los mira el servicio (recepción, encargado o dueño)', async () => {
    const s = services();
    const ctrl = new ReceptionController(s.cash as never, s.cards as never, s.charges as never, s.prisma as never);
    // Sin el guard de permisos: el camarero de recepción cobra sin que el dueño se lo dé.
    expect(new Reflector().get(STAFF_PERMISSION_KEY, ReceptionController.prototype.cashTopUp)).toBeUndefined();
    const body = { amountCents: 1_000, idempotencyKey: 'clave-0001', wallet: { create: true as const } };
    await ctrl.cashTopUp(user, body);
    expect(s.cash.topUp).toHaveBeenCalledWith(SALA, { userId: 'u-1', role: 'WAITER' }, body);
  });

  it('ficha acercada, código para grabar y al stock: con el local de quien llama', async () => {
    const s = services();
    const ctrl = new ReceptionController(s.cash as never, s.cards as never, s.charges as never, s.prisma as never);
    await ctrl.lookup(user, { card: FICHA });
    expect(s.charges.lookupForReception).toHaveBeenCalledWith(SALA, { card: FICHA, uid: null });
    // «Recargar saldo» en Inicio: también por su código.
    await ctrl.lookup(user, { code: 'K7Q-4M2' });
    expect(s.charges.lookupForReception).toHaveBeenCalledWith(SALA, { code: 'K7Q-4M2' });
    await ctrl.fichaToken(user);
    expect(s.cards.newStockToken).toHaveBeenCalledWith(SALA, { userId: 'u-1' });
    await ctrl.fichaStock(user, { card: FICHA, uid: '04A2' });
    expect(s.cards.stock).toHaveBeenCalledWith(SALA, { userId: 'u-1' }, { card: FICHA, uid: '04A2' });
  });

  it('recepción exprés: el NFC o el código, con quién llama (el servicio mira que cargue saldos)', async () => {
    const s = services();
    const ctrl = new ReceptionController(s.cash as never, s.cards as never, s.charges as never, s.prisma as never);
    expect(new Reflector().get('roles', ReceptionController.prototype.desk)).toEqual(['WAITER', 'MANAGER', 'OWNER']);
    await expect(ctrl.desk(user, { card: FICHA })).resolves.toEqual({ kind: 'new', fichaNumber: 522 });
    expect(s.cards.desk).toHaveBeenCalledWith(SALA, { userId: 'u-1', role: 'WAITER' }, { card: FICHA, uid: null });
    await ctrl.desk(user, { code: 'K7Q-4M2' });
    expect(s.cards.desk).toHaveBeenCalledWith(SALA, { userId: 'u-1', role: 'WAITER' }, { code: 'K7Q-4M2' });
  });
});

describe('recepción en el datáfono', () => {
  it('cada ruta va con el datáfono (sin persona) y su local', async () => {
    const s = services();
    const ctrl = new PosDeviceReceptionController(s.reception as never, s.charges as never, s.cards as never);
    await ctrl.options(device);
    expect(s.reception.options).toHaveBeenCalledWith(device);
    await ctrl.cash(device, { amountCents: 1, idempotencyKey: 'clave-0001', wallet: { create: true } });
    expect(s.reception.cashTopUp).toHaveBeenCalled();
    await ctrl.card(device, { amountCents: 1, idempotencyKey: 'clave-0001', wallet: { create: true } });
    expect(s.reception.cardTopUp).toHaveBeenCalled();
    await ctrl.lookup(device, { card: FICHA });
    expect(s.charges.lookupCardForReception).toHaveBeenCalledWith(SALA, { card: FICHA, uid: null });
    await ctrl.wallet(device, 'w');
    expect(s.charges.receptionWallet).toHaveBeenCalledWith(device, 'w');
    await ctrl.linkCard(device, 'w', { card: FICHA, uid: '04A2' });
    expect(s.charges.linkCardFromTerminal).toHaveBeenCalledWith(device, { walletId: 'w', card: FICHA, uid: '04A2' });
    await ctrl.pin(device, 'w', { pin: '4827' });
    expect(s.charges.setPinFromTerminal).toHaveBeenCalledWith(device, 'w', '4827');
    await ctrl.fichaToken(device);
    expect(s.cards.newStockToken).toHaveBeenCalledWith(SALA, { userId: null, terminalId: 'term-recepcion' });
    await ctrl.fichaStock(device, { card: FICHA });
    expect(s.cards.stock).toHaveBeenCalledWith(SALA, { userId: null, terminalId: 'term-recepcion' }, { card: FICHA, uid: null });
  });
});

describe('Clientes → Fichas (panel)', () => {
  it('lista (búsqueda recortada), resumen, bloquear y marcar perdida, del local de quien mira', async () => {
    const s = services();
    const ctrl = new WalletCardsController(s.cards as never);
    const manager = { sub: 'm-1', role: 'MANAGER', tenantId: SALA } as JwtPayload;
    await ctrl.list(manager, 'x'.repeat(100), 'ISSUED');
    expect(s.cards.list).toHaveBeenCalledWith(SALA, { q: 'x'.repeat(64), status: 'ISSUED' });
    await ctrl.summary(manager);
    expect(s.cards.summary).toHaveBeenCalledWith(SALA);
    await ctrl.block(manager, 'c-1');
    expect(s.cards.mark).toHaveBeenCalledWith({ userId: 'm-1', role: 'MANAGER', tenantId: SALA }, 'c-1', 'block');
    await ctrl.lost(manager, 'c-1');
    expect(s.cards.mark).toHaveBeenLastCalledWith({ userId: 'm-1', role: 'MANAGER', tenantId: SALA }, 'c-1', 'lost');
  });
});
