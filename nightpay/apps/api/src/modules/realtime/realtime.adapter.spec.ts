import { describe, it, expect, vi } from 'vitest';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { PING_INTERVAL_MS, PING_TIMEOUT_MS, RedisIoAdapter } from './realtime.adapter';

function fakeRedis() {
  const client = {
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    duplicate: vi.fn(),
  };
  return client;
}

function makeAdapter() {
  const pub = fakeRedis();
  const sub = fakeRedis();
  pub.duplicate.mockReturnValue(sub);
  const app = { get: () => ({ getOrThrow: () => 'redis://127.0.0.1:6399', get: () => undefined }) };
  const adapter = new RedisIoAdapter(app as never, () => pub as never);
  return { adapter, pub, sub };
}

describe('RedisIoAdapter al apagar', () => {
  it('cierra las conexiones pub/sub de Redis (si no, el proceso no termina)', async () => {
    const { adapter, pub, sub } = makeAdapter();
    await adapter.dispose();
    expect(pub.quit).toHaveBeenCalled();
    expect(sub.quit).toHaveBeenCalled();
  });

  it('si Redis no contesta, corta la conexión', async () => {
    const { adapter, pub } = makeAdapter();
    pub.quit.mockRejectedValue(new Error('closed'));
    await adapter.dispose();
    expect(pub.disconnect).toHaveBeenCalled();
  });
});

describe('RedisIoAdapter al crear el servidor', () => {
  it('detecta un socket muerto en unos 15 s (pingInterval 10 s + pingTimeout 5 s), no en 45 s', () => {
    const { adapter } = makeAdapter();
    const server = { adapter: vi.fn() };
    const create = vi.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue(server as never);
    adapter.createIOServer(0);
    const options = create.mock.calls[0]![1] as { pingInterval?: number; pingTimeout?: number; transports?: string[] };
    create.mockRestore();
    expect(options.pingInterval).toBe(10_000);
    expect(options.pingTimeout).toBe(5_000);
    expect(PING_INTERVAL_MS + PING_TIMEOUT_MS).toBe(15_000);
    expect(options.transports).toEqual(['websocket', 'polling']);
    expect(server.adapter).toHaveBeenCalledTimes(1);
  });
});
