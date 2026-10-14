import { beforeEach, describe, expect, it } from 'vitest';
import { clearFichaContext, readFichaContext, saveFichaContext } from './ficha-context';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage;
});

describe('lo que hacía la chica al acercar la ficha a un iPhone', () => {
  it('un cobro vale hasta que caduca', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    saveFichaContext({ userId: 'u1', kind: 'cobro', chargeId: 'c1', amountCents: 6000, serviceName: 'Masaje', expiresAt });
    expect(readFichaContext('u1')).toMatchObject({ kind: 'cobro', chargeId: 'c1' });
    expect(readFichaContext('u1', Date.now() + 120_000)).toBeNull();
    // Otra sesión en el mismo móvil no lo usa.
    expect(readFichaContext('u2')).toBeNull();
  });

  it('"dar ficha" solo unos minutos; borrar solo lo que toca', () => {
    saveFichaContext({ userId: 'u1', kind: 'dar', code: 'K7Q-4M2', at: Date.now() });
    expect(readFichaContext('u1')).toMatchObject({ kind: 'dar' });
    expect(readFichaContext('u1', Date.now() + 4 * 60_000)).toBeNull();
    clearFichaContext((c) => c.kind === 'cobro');
    expect(readFichaContext('u1')).not.toBeNull();
    clearFichaContext();
    expect(readFichaContext('u1')).toBeNull();
  });
});
