import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { PayoutAccountBackfill, reasonOf } from './payout-account-backfill';

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
