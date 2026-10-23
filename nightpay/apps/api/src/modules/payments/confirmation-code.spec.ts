import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contracts from '@nightpay/contracts';
import * as payRedirect from './pay-redirect';

/**
 * El código de confirmación («0C1») lo comparan el cliente y el personal: si
 * cada pantalla lo calculara a su manera, la comprobación dejaría de servir.
 * Una sola función (contracts) para el API, la app del personal y el TPV.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');

function sources(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/node_modules|\.next|dist|generated/.test(f))
    .map((f) => join(dir, f));
}

describe('confirmationCode: una sola para el cliente y el personal', () => {
  it('3 caracteres en mayúsculas del final del id, estables', () => {
    const id = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
    expect(contracts.confirmationCode(id)).toBe('A6B');
    expect(contracts.confirmationCode('0b8c2f1e-0000-4000-8000-0000000000c1')).toBe('0C1');
  });

  it('el API usa la de contracts (la misma función, no una copia)', () => {
    expect(payRedirect.confirmationCode).toBe(contracts.confirmationCode);
  });

  it('nadie más la define (las apps la importan de contracts)', () => {
    const defined = ['apps/api/src', 'apps/operator/src', 'apps/tpv/src', 'apps/admin/src', 'apps/web-client/src', 'packages']
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /function confirmationCode\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'));
    expect(defined).toEqual(['packages/contracts/src/confirmation-code.ts']);
  });
});
