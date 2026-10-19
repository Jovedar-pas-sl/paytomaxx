import { afterEach, describe, it, expect, vi } from 'vitest';
import { ApprovalNotifier } from './approval-notifier';

function make(sent = true) {
  const marks = new Set<string>();
  const redis = {
    set: vi.fn(async (key: string) => (marks.has(key) ? null : (marks.add(key), 'OK'))),
    del: vi.fn(async (key: string) => marks.delete(key)),
  };
  const telegram = { isConfigured: () => true, send: vi.fn().mockResolvedValue(sent) };
  return { notifier: new ApprovalNotifier(redis as never, telegram as never), redis, telegram };
}

describe('aviso por Telegram de una solicitud nueva', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('una sola vez por solicitud (la misma marca que la incidencia de los 30 min)', async () => {
    process.env.NODE_ENV = 'production';
    const { notifier, telegram, redis } = make();
    expect(await notifier.requested('t-1', 'ap-1', 'hola')).toBe(true);
    expect(await notifier.requested('t-1', 'ap-1', 'hola')).toBe(false);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('np:alert:t-1:approval_pending:ap-1', '1', 'EX', expect.any(Number), 'NX');
  });

  it('si Telegram falla se quita la marca (lo reintentan las alertas de Incidencias)', async () => {
    process.env.NODE_ENV = 'production';
    const { notifier, redis } = make(false);
    expect(await notifier.requested('t-1', 'ap-2', 'hola')).toBe(false);
    expect(redis.del).toHaveBeenCalledWith('np:alert:t-1:approval_pending:ap-2');
  });

  it('en pruebas no se manda nada', async () => {
    process.env.NODE_ENV = 'test';
    const { notifier, telegram } = make();
    expect(notifier.enabled()).toBe(false);
    expect(await notifier.requested('t-1', 'ap-3', 'hola')).toBe(false);
    expect(telegram.send).not.toHaveBeenCalled();
  });
});
