import { describe, expect, it } from 'vitest';
import { WALLET_EVENTS_CHANNEL, listenerConnectionString, parseWalletEvent } from './wallet-events';

const W = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const C = 'b7e1d2c3-0000-4000-8000-00000000beef';

describe('avisos del saldo (lo que mandan los triggers de Postgres)', () => {
  it('el canal es fijo: el de la migración 20261102100000_saldo_al_momento', () => {
    expect(WALLET_EVENTS_CHANNEL).toBe('np_wallet_events');
  });

  it('w:<saldo> → el saldo cambió', () => {
    expect(parseWalletEvent(`w:${W}`)).toEqual({ kind: 'wallet', walletId: W });
  });

  it('c:<cobro>:<estado> → el cobro del saldo cambió, con su estado', () => {
    for (const status of ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELED'] as const) {
      expect(parseWalletEvent(`c:${C}:${status}`)).toEqual({ kind: 'charge', chargeId: C, status });
    }
  });

  it('lo que no tiene la forma se ignora (nada de ids raros a una sala)', () => {
    for (const bad of [undefined, null, 42, '', 'w:', 'w:no-es-un-uuid', `x:${W}`, `c:${C}`, `c:${C}:PAGADO`, `c:${C}:ACCEPTED:extra`, `w:${W}:x`, ` w:${W}`]) {
      expect(parseWalletEvent(bad)).toBeNull();
    }
  });

  it('los ids salen en minúsculas (las salas de socket.io comparan texto)', () => {
    expect(parseWalletEvent(`w:${W.toUpperCase()}`)).toEqual({ kind: 'wallet', walletId: W });
  });
});

describe('la conexión del LISTEN', () => {
  it('quita los parámetros que solo entiende Prisma y deja los de Postgres (ssl, nombre de la app)', () => {
    const url = listenerConnectionString(
      'postgresql://np:secreto@db:5432/nightpay?connection_limit=20&pool_timeout=10&schema=public&pgbouncer=true&sslmode=disable&statement_cache_size=0',
    );
    const u = new URL(url);
    expect(u.searchParams.get('connection_limit')).toBeNull();
    expect(u.searchParams.get('pool_timeout')).toBeNull();
    expect(u.searchParams.get('schema')).toBeNull();
    expect(u.searchParams.get('pgbouncer')).toBeNull();
    expect(u.searchParams.get('statement_cache_size')).toBeNull();
    expect(u.searchParams.get('sslmode')).toBe('disable');
    expect(u.searchParams.get('application_name')).toBe('oxiopay-avisos-saldo');
    expect(`${u.username}:${u.password}@${u.host}${u.pathname}`).toBe('np:secreto@db:5432/nightpay');
  });

  it('un nombre de la app que ya venga en la URL se respeta', () => {
    expect(new URL(listenerConnectionString('postgres://a:b@h/db?application_name=mia')).searchParams.get('application_name')).toBe('mia');
  });
});
