import { describe, it, expect, vi } from 'vitest';
import { attachPrismaLogs, type PrismaLogEvent } from './prisma-logs';

/** Un cliente de mentira que guarda lo que se engancha a sus eventos de log. */
function fakeClient() {
  const handlers: Record<string, (e: PrismaLogEvent) => void> = {};
  const client = { $on: vi.fn((event: 'warn' | 'error', cb: (e: PrismaLogEvent) => void) => void (handlers[event] = cb)) };
  const logger = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  attachPrismaLogs(client, logger);
  const emit = (event: 'warn' | 'error', message: string, target: string) =>
    handlers[event]!({ message, target, timestamp: new Date() });
  return { client, logger, emit };
}

const logged = (fn: { mock: { calls: unknown[][] } }): string => fn.mock.calls.map((c) => String(c[0])).join('\n');

describe('eventos de log de Prisma (DI-08)', () => {
  it('se enganchan los dos: avisos y errores', () => {
    const { client } = fakeClient();
    expect(client.$on.mock.calls.map((c) => c[0])).toEqual(['warn', 'error']);
  });

  it('avisos del motor (pool, reconexiones) al log como aviso, con su origen', () => {
    const { logger, emit } = fakeClient();
    emit('warn', 'Timed out fetching a new connection from the connection pool', 'quaint::pooled');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logged(logger.warn)).toMatch(/quaint::pooled.*Timed out fetching a new connection/);
  });

  it('errores del motor al log como error, sin la contraseña de la URL de la base', () => {
    const { logger, emit } = fakeClient();
    emit('error', "Can't reach database server at `postgresql://np:s3cr3t@db:5432/nightpay`", 'query_engine::server');
    expect(logger.error).toHaveBeenCalledTimes(1);
    const text = logged(logger.error);
    expect(text).toContain("Can't reach database server");
    expect(text).not.toContain('s3cr3t');
  });

  it('el fallo de una consulta (lo trata quien la hizo): ni error en el log ni los datos de la consulta', () => {
    const { logger, emit } = fakeClient();
    emit(
      'error',
      'Invalid `prisma.user.create()` invocation:\n\n{\n  data: {\n    email: "ana@example.com",\n    passwordHash: "$2b$10$abc"\n  }\n}\n\nUnique constraint failed on the fields: (`email`)',
      'user.create',
    );
    emit('error', 'Raw query failed. Code: `23505`. Message: `Key (email)=(ana@example.com) already exists.`', '$executeRaw');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(2);
    const text = logged(logger.debug);
    expect(text).toContain('user.create');
    expect(text).not.toMatch(/ana@example\.com|\$2b\$10/);
  });

  it('un mensaje enorme del motor se recorta', () => {
    const { logger, emit } = fakeClient();
    emit('warn', 'x'.repeat(10_000), 'quaint::pooled');
    expect(logged(logger.warn).length).toBeLessThan(700);
  });
});
