import { describe, it, expect, vi } from 'vitest';
import { RedisModule } from './redis.module';

describe('RedisModule al apagar', () => {
  it('cierra la conexión (quit) para que el proceso termine limpio', async () => {
    const client = { quit: vi.fn().mockResolvedValue('OK'), disconnect: vi.fn() };
    await new RedisModule(client as never).onApplicationShutdown();
    expect(client.quit).toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('si Redis no contesta al quit, corta la conexión igualmente', async () => {
    const client = { quit: vi.fn().mockRejectedValue(new Error('Connection is closed')), disconnect: vi.fn() };
    await new RedisModule(client as never).onApplicationShutdown();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
