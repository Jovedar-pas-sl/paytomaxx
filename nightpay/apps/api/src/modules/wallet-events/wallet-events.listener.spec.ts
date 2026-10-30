import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LISTEN_PING_MS, LISTEN_RETRY_MAX_MS, WalletEventsListener, type ListenClient } from './wallet-events.listener';
import type { WalletEvent } from './wallet-events';

const W = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const C = 'b7e1d2c3-0000-4000-8000-00000000beef';

/** Un cliente de Postgres de mentira: lo que hace el de verdad (pg.Client) para el LISTEN. */
class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  ended = false;
  failConnect = false;
  hangPing = false;
  connect = vi.fn(async () => {
    if (this.failConnect) throw new Error('ECONNREFUSED');
  });
  query = vi.fn(async (sql: string) => {
    this.queries.push(sql);
    if (sql === 'SELECT 1' && this.hangPing) return new Promise(() => undefined);
    return { rows: [] };
  });
  end = vi.fn(async () => {
    this.ended = true;
  });
  notify(payload: string, channel = 'np_wallet_events'): void {
    this.emit('notification', { channel, payload, processId: 1 });
  }
}

function makeListener(config: Record<string, string | undefined> = { DATABASE_URL: 'postgresql://np:x@db:5432/nightpay?connection_limit=20' }) {
  const clients: FakeClient[] = [];
  const urls: string[] = [];
  const failNext = { connect: 0 };
  const factory = (url: string) => {
    urls.push(url);
    const c = new FakeClient();
    if (failNext.connect > 0) {
      failNext.connect -= 1;
      c.failConnect = true;
    }
    clients.push(c);
    return c;
  };
  const listener = new WalletEventsListener({ get: (k: string) => config[k] } as never, factory);
  const events: WalletEvent[] = [];
  const resyncs: number[] = [];
  listener.onEvent((e) => events.push(e));
  listener.onResync(() => resyncs.push(Date.now()));
  return { listener, clients, urls, events, resyncs, failNext };
}

/** Deja correr las promesas pendientes (connect → LISTEN). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WalletEventsListener: una conexión que escucha los avisos', () => {
  it('al arrancar: conecta con la URL de la base (sin lo de Prisma) y hace LISTEN del canal', async () => {
    const { listener, clients, urls } = makeListener();
    listener.onApplicationBootstrap();
    await settle();
    expect(clients).toHaveLength(1);
    expect(urls[0]).not.toContain('connection_limit');
    expect(clients[0]!.queries).toEqual(['LISTEN np_wallet_events']);
    expect(listener.listening).toBe(true);
    await listener.onApplicationShutdown();
  });

  it('WALLET_EVENTS_DATABASE_URL manda sobre DATABASE_URL (p. ej. directa, sin PgBouncer)', async () => {
    const { listener, urls } = makeListener({ DATABASE_URL: 'postgresql://a@pool/db', WALLET_EVENTS_DATABASE_URL: 'postgresql://a@directa/db' });
    listener.onApplicationBootstrap();
    await settle();
    expect(new URL(urls[0]!).host).toBe('directa');
    await listener.onApplicationShutdown();
  });

  it('reparte los avisos con forma; los de otro canal o raros, no', async () => {
    const { listener, clients, events } = makeListener();
    listener.onApplicationBootstrap();
    await settle();
    clients[0]!.notify(`w:${W}`);
    clients[0]!.notify(`c:${C}:ACCEPTED`);
    clients[0]!.notify(`w:${W}`, 'otro_canal');
    clients[0]!.notify('basura');
    expect(events).toEqual([
      { kind: 'wallet', walletId: W },
      { kind: 'charge', chargeId: C, status: 'ACCEPTED' },
    ]);
    await listener.onApplicationShutdown();
  });

  it('un oyente que falla no corta a los demás', async () => {
    const { listener, clients, events } = makeListener();
    listener.onEvent(() => {
      throw new Error('fallo de un oyente');
    });
    const late: WalletEvent[] = [];
    listener.onEvent((e) => late.push(e));
    listener.onApplicationBootstrap();
    await settle();
    clients[0]!.notify(`w:${W}`);
    expect(events).toHaveLength(1);
    expect(late).toHaveLength(1);
    await listener.onApplicationShutdown();
  });

  it('sin base que escuchar no arranca nada (y no impide arrancar el API)', async () => {
    const { listener, clients } = makeListener({});
    listener.onApplicationBootstrap();
    await settle();
    expect(clients).toHaveLength(0);
    expect(listener.listening).toBe(false);
    await listener.onApplicationShutdown();
  });

  it('NIGHTPAY_DISABLE_WALLET_EVENTS=1: apagado (todo va por el sondeo de respaldo)', async () => {
    const { listener, clients } = makeListener({ DATABASE_URL: 'postgresql://a@h/db', NIGHTPAY_DISABLE_WALLET_EVENTS: '1' });
    listener.onApplicationBootstrap();
    await settle();
    expect(clients).toHaveLength(0);
    await listener.onApplicationShutdown();
  });

  it('si la base no contesta al arrancar, reintenta con espera creciente (con tope) y sin lanzar', async () => {
    const { listener, clients, failNext } = makeListener();
    failNext.connect = 4;
    listener.onApplicationBootstrap();
    await settle();
    expect(clients).toHaveLength(1);
    expect(listener.listening).toBe(false);
    // 1 s, 2 s, 4 s, 8 s (con algo de azar por debajo): al quinto intento, conecta.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(LISTEN_RETRY_MAX_MS);
      await settle();
    }
    expect(clients.length).toBeGreaterThanOrEqual(5);
    expect(listener.listening).toBe(true);
    expect(clients.slice(0, 4).every((c) => c.ended)).toBe(true);
    await listener.onApplicationShutdown();
  });

  it('se corta la conexión: vuelve a escuchar y pide a todos que se pongan al día (pudo perderse un aviso)', async () => {
    const { listener, clients, resyncs, events } = makeListener();
    listener.onApplicationBootstrap();
    await settle();
    expect(resyncs).toHaveLength(0);
    clients[0]!.emit('error', new Error('server closed the connection unexpectedly'));
    expect(listener.listening).toBe(false);
    await vi.advanceTimersByTimeAsync(LISTEN_RETRY_MAX_MS);
    await settle();
    expect(clients).toHaveLength(2);
    expect(clients[1]!.queries).toEqual(['LISTEN np_wallet_events']);
    expect(resyncs).toHaveLength(1);
    // La vieja ya no reparte nada.
    clients[0]!.notify(`w:${W}`);
    expect(events).toHaveLength(0);
    clients[1]!.notify(`w:${W}`);
    expect(events).toHaveLength(1);
    await listener.onApplicationShutdown();
  });

  it('una conexión colgada (el SELECT 1 de control no vuelve) se da por perdida y se rehace', async () => {
    const { listener, clients } = makeListener();
    listener.onApplicationBootstrap();
    await settle();
    clients[0]!.hangPing = true;
    await vi.advanceTimersByTimeAsync(LISTEN_PING_MS * 2 + LISTEN_RETRY_MAX_MS);
    await settle();
    expect(clients.length).toBeGreaterThanOrEqual(2);
    expect(clients[0]!.ended).toBe(true);
    await listener.onApplicationShutdown();
  });

  it('al apagar: cierra la conexión y no vuelve a conectar', async () => {
    const { listener, clients } = makeListener();
    listener.onApplicationBootstrap();
    await settle();
    await listener.onApplicationShutdown();
    expect(clients[0]!.ended).toBe(true);
    clients[0]!.emit('end');
    await vi.advanceTimersByTimeAsync(LISTEN_RETRY_MAX_MS * 2);
    expect(clients).toHaveLength(1);
  });
});
