import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailService, maskEmail } from './email.service';

/**
 * El correo (Resend): la dirección nunca entra entera en el registro (sale
 * enmascarada, «m***@g***.com», en sus cuatro líneas) y una llamada a Resend
 * no se queda colgada: 10 s como mucho (idea 68).
 */

const TO = 'maria.lopez@gmail.com';
const MASKED = 'm***@g***.com';

function service(apiKey?: string) {
  const config = { get: vi.fn((k: string) => (k === 'RESEND_API_KEY' ? apiKey : undefined)) };
  const email = new EmailService(config as never);
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(email, { logger });
  return { email, logger };
}

const logged = (logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }): string =>
  [...logger.log.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map((c) => c.join(' ')).join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('maskEmail', () => {
  it('la primera letra de cada parte y el final del dominio', () => {
    expect(maskEmail(TO)).toBe(MASKED);
    expect(maskEmail('a@b.co.uk')).toBe('a***@b***.uk');
    expect(maskEmail('Pepe@Empresa')).toBe('P***@E***');
    expect(maskEmail('sin-arroba')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});

describe('EmailService: la dirección enmascarada en sus cuatro registros', () => {
  const input = { to: TO, subject: 'Tu justificante de 35,00 €', html: '<p>x</p>', text: 'x' };

  it('sin RESEND_API_KEY (NoOp)', async () => {
    const { email, logger } = service();
    expect(email.isEnabled()).toBe(false);
    await expect(email.send(input)).resolves.toMatchObject({ ok: true, delivered: false });
    expect(logged(logger)).toContain(`to=${MASKED}`);
    expect(logged(logger)).not.toContain(TO);
  });

  it('enviado, rechazado por Resend o con un error de red', async () => {
    for (const [fetchImpl, result] of [
      [async () => ({ ok: true, status: 200, text: async () => '' }), { ok: true, delivered: true }],
      [async () => ({ ok: false, status: 422, text: async () => `{"message":"bad ${TO}"}` }), { ok: false, delivered: false }],
      [async () => Promise.reject(new Error('ECONNRESET')), { ok: false, delivered: false, reason: 'exception' }],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(fetchImpl));
      const { email, logger } = service('re_test');
      await expect(email.send(input)).resolves.toMatchObject(result);
      expect(logged(logger)).toContain(`to=${MASKED}`);
      // Ni siquiera dentro de la respuesta de Resend.
      expect(logged(logger)).not.toContain(TO);
    }
  });

  it('a Resend sí le llega la dirección entera (es quien la entrega)', async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchFn);
    await service('re_test').email.send(input);
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1].body)) as { to: string[] };
    expect(body.to).toEqual([TO]);
  });
});

describe('EmailService: tiempo máximo', () => {
  it('la llamada a Resend lleva AbortSignal.timeout(10_000); al cortarse, un fallo (no se queda colgada)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    vi.stubGlobal('fetch', fetchFn);
    const { email, logger } = service('re_test');
    await expect(email.send({ to: TO, subject: 's', html: 'h' })).resolves.toEqual({ ok: false, delivered: false, reason: 'exception' });
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(logged(logger)).not.toContain(TO);
    timeout.mockRestore();
  });
});
