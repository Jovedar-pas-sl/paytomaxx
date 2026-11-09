import { describe, expect, it, vi } from 'vitest';
import { ClientErrorsService, MAX_ALERTS_PER_HOUR, cleanMessage, cleanPath, linklessPath } from './client-errors.service';

function make(o: { configured?: boolean; first?: boolean; sentThisHour?: number } = {}) {
  let count = o.sentThisHour ?? 0;
  const redis = {
    set: vi.fn(async () => (o.first === false ? null : 'OK')),
    incr: vi.fn(async () => ++count),
    expire: vi.fn(async () => 1),
  };
  const telegram = { isConfigured: vi.fn(() => o.configured ?? true), send: vi.fn(async () => true) };
  const metrics = { clientErrors: { inc: vi.fn() } };
  const service = new ClientErrorsService(redis as never, telegram as never, metrics as never);
  return { service, redis, telegram, metrics };
}

describe('fallos de pantalla de las apps', () => {
  it('cuenta, y avisa por Telegram con la app y la ruta, sin el texto libre del mensaje', async () => {
    const { service, telegram, metrics } = make();
    await service.report({ app: 'operator', message: "Cannot read properties of undefined (reading 'x')", path: '/?t=cobros' });
    expect(metrics.clientErrors.inc).toHaveBeenCalledWith({ app: 'operator' });
    const text = telegram.send.mock.calls[0]![0] as string;
    expect(text).toContain('la app del personal en /');
    // El mensaje lo escribe quien manda el aviso: al registro, no al chat del dueño.
    expect(text).not.toContain("reading 'x'");
    expect(text).toMatch(/huella [0-9a-f]{16}/);
  });

  it('el mismo fallo, una vez por hora', async () => {
    const { service, redis, telegram } = make({ first: false });
    await service.report({ app: 'admin', message: 'boom' });
    expect(redis.set).toHaveBeenCalledWith(expect.stringMatching(/^np:client-error:[0-9a-f]{16}$/), '1', 'EX', 3600, 'NX');
    expect(redis.incr).not.toHaveBeenCalled();
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('el mismo fallo con otros números es el mismo fallo (la huella no cambia)', async () => {
    const { service, redis } = make();
    await service.report({ app: 'admin', message: 'Timeout 1234 ms en la fila 17' });
    await service.report({ app: 'admin', message: 'Timeout 98 ms en la fila 3' });
    expect(redis.set.mock.calls[0]![0]).toBe(redis.set.mock.calls[1]![0]);
  });

  it('con un tope por hora para todos: al pasarlo avisa una vez de que se calla y luego nada', async () => {
    const atCap = make({ sentThisHour: MAX_ALERTS_PER_HOUR });
    await atCap.service.report({ app: 'admin', message: 'uno más' });
    expect(atCap.telegram.send).toHaveBeenCalledTimes(1);
    expect(atCap.telegram.send.mock.calls[0]![0]).toContain('dejo de avisar');

    const over = make({ sentThisHour: MAX_ALERTS_PER_HOUR + 1 });
    await over.service.report({ app: 'admin', message: 'y otro' });
    expect(over.telegram.send).not.toHaveBeenCalled();
    // La cuenta de la hora caduca sola.
    expect(over.redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^np:client-error:tg:\d+$/));
  });

  it('la primera de la hora pone la caducidad de la cuenta', async () => {
    const { service, redis } = make();
    await service.report({ app: 'tpv', message: 'boom' });
    expect(redis.expire).toHaveBeenCalledWith(expect.stringMatching(/^np:client-error:tg:\d+$/), 3600);
  });

  it('sin Telegram configurado: solo registro y métrica', async () => {
    const { service, redis, telegram, metrics } = make({ configured: false });
    await service.report({ app: 'tpv', message: 'boom' });
    expect(metrics.clientErrors.inc).toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('nunca guarda tokens, correos, enlaces ni consultas', () => {
    expect(cleanPath('/w/AbCdEfGhIjKlMnOpQrStUv?lang=es')).toBe('/w/…');
    expect(cleanPath('/pay/x9y8z7w6v5u4t3s2#a')).toBe('/pay/…');
    expect(cleanPath('/?saldo=K7Q4M2')).toBe('/');
    expect(cleanPath(undefined)).toBeNull();
    expect(cleanMessage('fallo de ana@local.es con eyJhbGciOiJIUzI1NiJ9abcdefgh')).toBe('fallo de …@… con …');
    expect(cleanMessage('Failed to fetch https://api.x.es/w/abc123?saldo=K7Q4M2 ya')).toBe('Failed to fetch [enlace] ya');
    expect(cleanMessage('no va '.repeat(100))).toHaveLength(200);
    expect(cleanMessage('  ')).toBe('sin mensaje');
  });

  it('una sola línea: sin saltos ni caracteres de control que falseen el registro', () => {
    expect(cleanMessage('uno\nERROR Pago aprobado\r\u0000dos')).toBe('uno ERROR Pago aprobado dos');
    expect(cleanPath('/x\n2026 ERROR Pago')).not.toMatch(/\s/);
  });

  it('la ruta del Telegram no se puede convertir en un enlace', () => {
    expect(linklessPath('//evil.tld/entra:aqui')).toBe('//eviltld/entraaqui');
    expect(linklessPath('/w/…')).toBe('/w/…');
  });
});
