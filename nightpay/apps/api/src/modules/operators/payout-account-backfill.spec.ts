import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { reportError } from '../../common/observability/sentry';
import { PayoutAccountBackfill, reasonOf } from './payout-account-backfill';

vi.mock('../../common/observability/sentry', () => ({ reportError: vi.fn() }));

const IBAN = 'ES9121000418450200051332';
const KEK = 'test_kek_0123456789abcdef0123456789abcdef_v1';

describe('el relleno no deja la cuenta en el log', () => {
  it('de un fallo de la base apunta el tipo y el código, no su mensaje (podría llevar la cuenta)', () => {
    const db = new Prisma.PrismaClientKnownRequestError(`Raw query failed: valor "${IBAN}"`, { code: 'P2010', clientVersion: 'x' });
    expect(reasonOf(db)).toBe('PrismaClientKnownRequestError P2010');
    expect(reasonOf(new Error('ENCRYPTION_KEK no configurada'))).toBe('ENCRYPTION_KEK no configurada');
    expect(reasonOf('x')).toBe('error desconocido');
  });

  it('una fila que falla al escribirse se cuenta, no para las demás y no deja su cuenta en el log', async () => {
    const rows = [
      { id: '0b0c1f6e-1111-4c4c-8a8a-000000000001', payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: null, payoutLabel: null },
      { id: '0b0c1f6e-1111-4c4c-8a8a-000000000002', payoutMethod: 'USDT_TRC20', payoutAddress: 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV', payoutMetadata: null, payoutLabel: null },
    ];
    let read = 0;
    let writes = 0;
    const tx = {
      // Primera lectura: las dos personas; después, nada más (ni personas ni pagos).
      $queryRaw: vi.fn(async () => (read++ === 0 ? rows : [])),
      $executeRaw: vi.fn(async () => {
        if (writes++ === 0) throw new Prisma.PrismaClientKnownRequestError(`falló con "${IBAN}"`, { code: 'P2010', clientVersion: 'x' });
        return 1;
      }),
    };
    const backfill = new PayoutAccountBackfill({ asSystem: (fn: (t: typeof tx) => unknown) => fn(tx) } as never);
    const logged: string[] = [];
    (backfill as unknown as { logger: { error: (m: string) => void; log: (m: string) => void } }).logger = {
      error: (m) => void logged.push(m),
      log: (m) => void logged.push(m),
    };
    expect(await backfill.run(KEK)).toEqual({ accounts: 1, payouts: 0, failed: 1 });
    expect(logged.join('\n')).not.toContain(IBAN);
    // Lo que se escribe tampoco lleva la cuenta en claro como valor nuevo.
    const written = tx.$executeRaw.mock.calls[1] as unknown[];
    expect(String(written[1])).toMatch(/^pa1:/);
  });
});

describe('al arrancar, el relleno dice cómo ha quedado (y si queda algo en claro, se oye)', () => {
  const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(reportError).mockClear();
  });

  /** Un relleno sobre una base de mentira: `pages`, lo que devuelve cada lectura, en orden (la última, cuántas quedan en claro). */
  function make(pages: unknown[][]) {
    let read = 0;
    const tx = { $queryRaw: vi.fn(async () => pages[read++] ?? []), $executeRaw: vi.fn(async () => 1) };
    const backfill = new PayoutAccountBackfill({ asSystem: (fn: (t: typeof tx) => unknown) => fn(tx) } as never);
    const errors: string[] = [];
    const logs: string[] = [];
    (backfill as unknown as { logger: { error: (m: string) => void; log: (m: string) => void } }).logger = {
      error: (m) => void errors.push(m),
      log: (m) => void logs.push(m),
    };
    return { backfill, tx, errors, logs };
  }
  const person = (n: number, payoutAddress: string) => ({
    id: `0b0c1f6e-1111-4c4c-8a8a-00000000000${n}`,
    payoutMethod: 'USDT_TRC20',
    payoutAddress,
    payoutMetadata: null,
    payoutLabel: null,
  });

  it('todo cifrado: lo dice en una línea, sin error', async () => {
    vi.stubEnv('ENCRYPTION_KEK', KEK);
    // Una persona en claro; después ni más personas ni pagos; y al contar, ninguna.
    const { backfill, errors, logs } = make([[person(1, TRON)], [], [], [{ n: 0 }]]);
    await backfill.runLogged();
    expect(errors).toEqual([]);
    expect(logs).toEqual(['Cuentas de cobro cifradas: 1 personas y 0 pagos (0 sin poder)', 'Cuentas de cobro: ninguna en claro']);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('sin ENCRYPTION_KEK no cifra nada: error en el log y a Sentry con cuántas quedan, sin ninguna cuenta', async () => {
    vi.stubEnv('ENCRYPTION_KEK', '');
    const { backfill, tx, errors } = make([[person(1, TRON), person(2, IBAN)], [], [], [{ n: 2 }]]);
    await backfill.runLogged();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(errors.at(-1)).toMatch(/^Cuentas de cobro EN CLARO tras el relleno: 2 /);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((reported as Error).message).toMatch(/^Cuentas de cobro EN CLARO tras el relleno: 2 /);
    expect(context).toEqual({ tag: 'payout-account-backfill' });
    expect(`${errors.join('\n')}${(reported as Error).message}`).not.toContain(IBAN);
    expect(`${errors.join('\n')}${(reported as Error).message}`).not.toContain(TRON);
  });

  it('las que escribió en claro el API anterior después de pasar el relleno también cuentan (aunque nada fallara)', async () => {
    vi.stubEnv('ENCRYPTION_KEK', KEK);
    const { backfill, errors } = make([[], [], [{ n: 1 }]]);
    await backfill.runLogged();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Cuentas de cobro EN CLARO tras el relleno: 1 /);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('si el relleno no termina (la base no contesta), también se oye, y no impide arrancar', async () => {
    const broken = new PayoutAccountBackfill({ asSystem: async () => Promise.reject(new Error('base caída')) } as never);
    const errors: string[] = [];
    (broken as unknown as { logger: { error: (m: string) => void } }).logger = { error: (m) => void errors.push(m) };
    await expect(broken.runLogged()).resolves.toBeUndefined();
    expect(errors).toEqual(['El relleno de las cuentas de cobro no ha terminado (se repite al arrancar): base caída']);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
