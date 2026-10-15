import { describe, it, expect, vi } from 'vitest';
import { RedisIoAdapter } from './realtime.adapter';

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
