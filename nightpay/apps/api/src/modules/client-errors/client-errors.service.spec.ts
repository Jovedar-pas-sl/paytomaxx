import { describe, expect, it, vi } from 'vitest';
import { ClientErrorsService, cleanMessage, cleanPath } from './client-errors.service';

function make(o: { configured?: boolean; first?: boolean } = {}) {
  const redis = { set: vi.fn(async () => (o.first === false ? null : 'OK')) };
  const telegram = { isConfigured: vi.fn(() => o.configured ?? true), send: vi.fn(async () => true) };
  const metrics = { clientErrors: { inc: vi.fn() } };
  const service = new ClientErrorsService(redis as never, telegram as never, metrics as never);
  return { service, redis, telegram, metrics };
}

describe('fallos de pantalla de las apps', () => {
  it('cuenta, y avisa por Telegram con la app, la ruta y el mensaje', async () => {
    const { service, telegram, metrics } = make();
    await service.report({ app: 'operator', message: "Cannot read properties of undefined (reading 'x')", path: '/?t=cobros' });
    expect(metrics.clientErrors.inc).toHaveBeenCalledWith({ app: 'operator' });
    expect(telegram.send).toHaveBeenCalledWith(expect.stringContaining('la app del personal en /'));
    expect(telegram.send.mock.calls[0]![0]).toContain("reading 'x'");
  });

  it('el mismo fallo, una vez por hora', async () => {
    const { service, redis, telegram } = make({ first: false });
    await service.report({ app: 'admin', message: 'boom' });
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^np:client-error:[0-9a-f]{16}$/), '1', 'EX', 3600, 'NX');
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('sin Telegram configurado: solo registro y métrica', async () => {
    const { service, redis, telegram, metrics } = make({ configured: false });
    await service.report({ app: 'tpv', message: 'boom' });
    expect(metrics.clientErrors.inc).toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('nunca guarda tokens, correos ni consultas', () => {
    expect(cleanPath('/w/AbCdEfGhIjKlMnOpQrStUv?lang=es')).toBe('/w/…');
    expect(cleanPath('/pay/x9y8z7w6v5u4t3s2#a')).toBe('/pay/…');
    expect(cleanPath('/?saldo=K7Q4M2')).toBe('/');
    expect(cleanPath(undefined)).toBeNull();
    expect(cleanMessage('fallo de ana@local.es con eyJhbGciOiJIUzI1NiJ9abcdefgh')).toBe('fallo de …@… con …');
    expect(cleanMessage('no va '.repeat(100))).toHaveLength(200);
    expect(cleanMessage('  ')).toBe('sin mensaje');
  });
});
