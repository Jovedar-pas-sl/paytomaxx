import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import type { WalletLoadRequestBody } from '@nightpay/contracts';
import type { PartnerAuth } from '../auth/current-connection.decorator';
import { PartnerHttpException } from '../http/partner-problem';
import { loadRequestHash } from './partner-load-rules';
import { PartnerLoadsService, isLoadBusy } from './partner-loads.service';

/**
 * El servicio de las cargas sin base (A4): la repetición sale antes de mirar
 * el `qr`, el saldo, el local y los topes; lo que dice «ocupado» antes de que
 * acabe la función de la transacción es 503 try_later; un fallo al confirmar,
 * 500 internal_error (puede estar guardada); y otra petición con la clave de
 * una carga hecha, 422 idempotency_key_reused con esa carga.
 */

const sql = vi.hoisted(() => ({
  loadByKey: vi.fn(),
  loadById: vi.fn(),
  lockLoad: vi.fn(),
  listLoads: vi.fn(),
  loadWindowTotals: vi.fn(),
  partnerStatementSql: vi.fn(),
}));
vi.mock('./partner-loads.sql', () => sql);
vi.mock('../../wallets/wallet-activation', () => ({ reopenData: vi.fn(async () => ({})) }));
vi.mock('../../wallets/wallet-cash-limits', async (orig) => ({
  ...(await orig<typeof import('../../wallets/wallet-cash-limits')>()),
  walletCash: vi.fn(async () => ({ inWindowCents: 0, inWindowPaidCents: 0 })),
}));
vi.mock('../../wallets/wallet-merge-chain', async (orig) => ({
  ...(await orig<typeof import('../../wallets/wallet-merge-chain')>()),
  mergedWalletIds: vi.fn(async (_tx: unknown, id: string) => [id]),
}));

const KEY = 'ATM0042-20261205-000731-K7QM';
const BODY: WalletLoadRequestBody = {
  qr: 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001',
  nfc_uid: '04A1B2C3D4E5F6',
  amount: 2000,
  description: 'Recarga en cajero 0042',
  reference: KEY,
  funding: 'cash',
  device: 'ATM0042',
};
const STORED = {
  object: 'wallet_load',
  id: 'wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b',
  status: 'succeeded',
  amount: 2000,
  balance_after: 7000,
};

const auth = {
  connection: { id: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222', keyMode: 'test', partner: { name: 'Cajeros' } },
  keyHint: 'oxp_test_…cdef',
  keyHash: 'f'.repeat(64),
  keyMatch: 'current',
  effectiveScopes: ['wallet:balance', 'wallet:load'],
} as unknown as PartnerAuth;

const pgError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: '5.22.0', meta: { code } });

let refs: { resolveLocked: ReturnType<typeof vi.fn>; isReachable: ReturnType<typeof vi.fn> };
let asSystem: ReturnType<typeof vi.fn>;
let service: PartnerLoadsService;
const tx = { $executeRawUnsafe: vi.fn(async () => 0), $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) };

beforeEach(() => {
  vi.clearAllMocks();
  refs = { resolveLocked: vi.fn(), isReachable: vi.fn() };
  asSystem = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  const config = { get: () => 'https://api.oxiopay.example' };
  service = new PartnerLoadsService(
    { asSystem, withTenant: vi.fn() } as never,
    refs as never,
    { loadsPerWallet: vi.fn() } as never,
    { loaded: vi.fn(async () => undefined), refused: vi.fn(async () => undefined), apiVoided: vi.fn(async () => undefined) } as never,
    { log: vi.fn(), logInTx: vi.fn() } as never,
    { loadVoided: vi.fn() } as never,
    { assertForUser: vi.fn(), isEnabled: vi.fn() } as never,
    config as never,
  );
});

const create = (body: unknown = BODY, key = KEY) => service.create(auth, { 'idempotency-key': key }, body, Date.now());

async function problemOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PartnerHttpException) return err.code;
    throw err;
  }
  throw new Error('no lanzó');
}

describe('crear una carga', () => {
  it('la repetición (misma clave y huella) devuelve la respuesta guardada sin llamar al resolvedor', async () => {
    sql.loadByKey.mockResolvedValue({ id: '8b2e6f1a-9c3d-4e5f-8a7b-6c5d4e3f2a1b', requestHash: loadRequestHash(BODY), response: STORED, voidedAt: null });
    const out = await create({ ...BODY, description: '  Recarga  en cajero 0042 ' });
    expect(out).toEqual({ body: STORED, replayed: true });
    expect(refs.resolveLocked).not.toHaveBeenCalled();
    // Con el candado de la clave y los tiempos de la transacción.
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '10s'`);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL statement_timeout = '10s'`);
    expect(asSystem).toHaveBeenCalledWith(expect.any(Function), { maxWait: 5_000, timeout: 20_000 });
  });

  it('`card` con la clave de una carga hecha: 422 idempotency_key_reused con esa carga (estado de ahora)', async () => {
    sql.loadByKey.mockResolvedValue({
      id: '8b2e6f1a-9c3d-4e5f-8a7b-6c5d4e3f2a1b',
      requestHash: loadRequestHash(BODY),
      response: STORED,
      amountCents: 2000,
      createdAt: new Date('2026-12-05T22:41:07Z'),
      voidedAt: new Date('2026-12-05T22:45:00Z'),
    });
    try {
      await create({ ...BODY, funding: 'card' });
      throw new Error('no lanzó');
    } catch (err) {
      expect(err).toBeInstanceOf(PartnerHttpException);
      const e = err as PartnerHttpException;
      expect(e.code).toBe('idempotency_key_reused');
      expect(e.extra.operation).toEqual({
        object: 'wallet_load',
        id: 'wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b',
        status: 'voided',
        amount: 2000,
        created_at: '2026-12-05T22:41:07.000Z',
      });
    }
    expect(refs.resolveLocked).not.toHaveBeenCalled();
  });

  it('sin clave, 400 idempotency_key_missing antes de mirar el cuerpo', async () => {
    await expect(problemOf(service.create(auth, {}, { nada: true }, Date.now()))).resolves.toBe('idempotency_key_missing');
    expect(asSystem).not.toHaveBeenCalled();
  });

  it.each(['55P03', '57014', '40P01'])('Postgres %s antes de acabar la función: 503 try_later', async (code) => {
    sql.loadByKey.mockRejectedValue(pgError(code));
    await expect(problemOf(create())).resolves.toBe('try_later');
  });

  it('P2028 (la transacción caducó o no llegó al pool) y P2034: 503 try_later', async () => {
    sql.loadByKey.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Transaction API error', { code: 'P2028', clientVersion: '5.22.0' }));
    await expect(problemOf(create())).resolves.toBe('try_later');
    sql.loadByKey.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Write conflict or deadlock', { code: 'P2034', clientVersion: '5.22.0' }));
    await expect(problemOf(create())).resolves.toBe('try_later');
  });

  it('pasados los 25 s desde que llegó: 503 try_later (la función acaba con el corte)', async () => {
    sql.loadByKey.mockResolvedValue({ id: 'x', requestHash: loadRequestHash(BODY), response: STORED, voidedAt: null });
    await expect(problemOf(service.create(auth, { 'idempotency-key': KEY }, BODY, Date.now() - 25_001))).resolves.toBe('try_later');
  });

  it('un fallo al confirmar (tras acabar la función) es 500 internal_error, aunque diga «ocupado»', async () => {
    sql.loadByKey.mockResolvedValue({ id: 'x', requestHash: loadRequestHash(BODY), response: STORED, voidedAt: null });
    asSystem.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => {
      await fn(tx);
      throw new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: '5.22.0' });
    });
    await expect(problemOf(create())).resolves.toBe('internal_error');
  });

  it('otros errores de la base no son «ocupado»', () => {
    expect(isLoadBusy(pgError('23505'))).toBe(false);
    expect(isLoadBusy(new Error('cualquier cosa'))).toBe(false);
    expect(isLoadBusy(pgError('55P03'))).toBe(true);
  });
});

describe('la hora de una carga', () => {
  it('es la de escribir, no la de mirar los topes: un cierre entre medias la deja en el Z siguiente', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const checked = new Date('2026-12-05T22:41:07.000Z');
    const written = new Date('2026-12-05T22:41:09.500Z');
    vi.setSystemTime(checked);
    try {
      sql.loadByKey.mockResolvedValue(null);
      // Mirar los topes tarda: el reloj pasa (y un cierre de noche podría cortar justo aquí).
      sql.loadWindowTotals.mockImplementation(async () => {
        vi.setSystemTime(written);
        return { wallet24h: 0, wallet24hAllPartners: 0, wallet30dPartner: 0, connectionNight: 0 };
      });
      const WALLET = '33333333-3333-4333-8333-333333333333';
      refs.resolveLocked.mockResolvedValue({ wallet: { id: WALLET, balanceCents: 5000, status: 'ACTIVE' }, refKind: 'ficha_nfc' });
      const rows: Record<string, Date> = {};
      Object.assign(tx, {
        venue: { findUnique: vi.fn(async () => ({ pausedAt: null, business: { status: 'ACTIVE' }, paymentMethods: null })) },
        partnerConnection: {
          findFirst: vi.fn(async () => ({
            status: 'ACTIVE',
            keyHash: auth.keyHash,
            prevKeyHash: null,
            prevKeyExpiresAt: null,
            keyExpiresAt: null,
            keySuspendedAt: null,
            businessId: 'b',
            scopes: ['wallet:load'],
            pausedScopes: [],
            collectionModel: 'VENUE_COLLECTS',
            loadPerOpMaxCents: 30000,
            loadWalletDayMaxCents: 60000,
            loadNightMaxCents: 500000,
            partner: { id: 'p', name: 'Cajeros', status: 'ACTIVE', allowedScopes: ['wallet:load'] },
            venue: { deletedAt: null, businessId: 'b', business: { taxId: 'B00000000' } },
          })),
        },
        clientWallet: { update: vi.fn(async () => ({})) },
        walletCashTopUp: {
          create: vi.fn(async ({ data }: { data: { createdAt: Date } }) => {
            rows.cash = data.createdAt;
            return { id: 'cash-1' };
          }),
        },
        partnerWalletOperation: {
          create: vi.fn(async ({ data }: { data: { createdAt: Date } }) => {
            rows.load = data.createdAt;
            return {};
          }),
        },
      });
      const out = await service.create(auth, { 'idempotency-key': KEY }, BODY, written.getTime());
      expect(rows).toEqual({ cash: written, load: written });
      expect(out.body.created_at).toBe(written.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});
