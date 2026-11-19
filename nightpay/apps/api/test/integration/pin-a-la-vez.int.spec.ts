// Integración (Postgres real, np_app con FORCE RLS): el PIN del saldo con
// varios intentos a la vez (prueba de carga del 19-11-2026). El PIN (scrypt)
// se calcula sin el saldo bloqueado y el resultado se apunta con el saldo
// bloqueado: el contador de fallos y el bloqueo tras 5 siguen exactos, y un
// PIN bueno que llega con el saldo ya bloqueado no vale.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const charges = new WalletChargesService(prisma as never, { log: vi.fn(async () => undefined) } as never, { get: () => ({}) } as never, {} as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 'pin' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string;
let n = 0;

/** Un saldo con PIN 4827 y `fails` fallos de hace un momento. */
async function wallet(fails = 0): Promise<string> {
  n += 1;
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents: 5_000, qrToken: `pin-${r}-${n}-abcdefgh`, walletGroup: `gpin-${r}` },
    });
    return w.id;
  });
  await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
  if (fails) await sys((tx) => tx.clientWallet.update({ where: { id }, data: { pinFails: fails, pinFailedAt: new Date() } }));
  return id;
}

const tryPin = (walletId: string, pin: string) =>
  inVenue(undefined, () => charges.checkClientPin(walletId, V, pin)).then(
    () => 'ok',
    (err: { response?: { code?: string } }) => err.response?.code ?? String(err),
  );
const state = (id: string) =>
  sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id }, select: { pinFails: true, pinLockedAt: true } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  V = (await sys((tx) => tx.venue.create({ data: { name: 'Sala Pin', slug: `pin-${r}`, walletGroup: `gpin-${r}`, platformCommissionBps: 0 } }))).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('el PIN del saldo con varios intentos a la vez', () => {
  it('8 PIN malos a la vez: cuentan 5 y el saldo queda bloqueado; los demás, «bloqueado» sin contar', async () => {
    const id = await wallet();
    const out = await Promise.all(Array.from({ length: 8 }, () => tryPin(id, '1111')));
    expect(out.filter((x) => x === 'PIN_WRONG')).toHaveLength(4);
    expect(out.filter((x) => x === 'PIN_LOCKED')).toHaveLength(4);
    const s = await state(id);
    expect(s.pinFails).toBe(5);
    expect(s.pinLockedAt).not.toBeNull();
    // Bloqueado, ni el bueno pasa.
    await expect(tryPin(id, '4827')).resolves.toBe('PIN_LOCKED');
  });

  it('con 4 fallos, el bueno y uno malo a la vez: o pasa el bueno (y el malo cuenta 1) o bloquea el malo (y el bueno no vale)', async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await wallet(4);
      const [good, bad] = await Promise.all([tryPin(id, '4827'), tryPin(id, '1111')]);
      const s = await state(id);
      if (good === 'ok') {
        expect(bad).toBe('PIN_WRONG');
        expect(s).toMatchObject({ pinFails: 1, pinLockedAt: null });
      } else {
        expect([good, bad]).toEqual(['PIN_LOCKED', 'PIN_LOCKED']);
        expect(s.pinFails).toBe(5);
        expect(s.pinLockedAt).not.toBeNull();
      }
    }
  });

  it('muchos PIN buenos a la vez: todos valen y el contador queda a cero', async () => {
    const id = await wallet(3);
    const out = await Promise.all(Array.from({ length: 6 }, () => tryPin(id, '4827')));
    expect(out).toEqual(Array(6).fill('ok'));
    expect(await state(id)).toMatchObject({ pinFails: 0, pinLockedAt: null });
  });
});
