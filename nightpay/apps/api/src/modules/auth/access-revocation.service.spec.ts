import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpStatus, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  ACCESS_CHECK_TIMEOUT_MS,
  ACCESS_REVOCATION_TTL_SECONDS,
  ACCESS_TOKEN_TTL_SECONDS,
  AccessRevocationService,
  SESSION_CHECK_RETRY_AFTER_S,
  SESSION_CHECK_UNAVAILABLE_CODE,
  SESSION_CHECK_WARN_EVERY_MS,
} from './access-revocation.service';
import { createFakeRedis } from './testing/fake-redis';

const USER = '7d0f4f9e-0000-4000-8000-0000000000cc';
const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-26T22:00:00.000Z');
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

function make() {
  const redis = createFakeRedis();
  return { redis, svc: new AccessRevocationService(redis as never) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AccessRevocationService — ¿sigue viva la sesión de este token?', () => {
  it('sin revocar nada, cualquier token vale (también los de antes de este cambio)', async () => {
    const { svc } = make();
    await expect(svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).resolves.toBe(false);
    // Sin sid (forma antigua del token): sigue valiendo hasta que caduque.
    await expect(svc.isRevoked({ sub: USER, iat: sec(T0) })).resolves.toBe(false);
  });

  it('revocar UNA sesión (logout, reuso del refresh) corta solo los tokens de esa sesión', async () => {
    const { svc } = make();
    await svc.revokeSession(SID_A);
    await expect(svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).resolves.toBe(true);
    await expect(svc.isRevoked({ sub: USER, sid: SID_B, iat: sec(T0) })).resolves.toBe(false);
  });

  it('revocar TODAS las sesiones de una persona corta los tokens emitidos antes; uno de un login nuevo, no', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0.getTime() + 700));
    const { svc } = make();
    const before = sec(T0) - 30;
    await svc.revokeUser(USER);
    await expect(svc.isRevoked({ sub: USER, sid: SID_A, iat: before })).resolves.toBe(true);
    // Del mismo segundo: la marca de la persona no basta (iat va en segundos y
    // un login justo después vale); a ese lo corta la marca de su sesión.
    await expect(svc.isRevoked({ sub: USER, sid: SID_B, iat: sec(T0) })).resolves.toBe(false);
    // También los de la forma antigua (sin sid) y los que no traen fecha.
    await expect(svc.isRevoked({ sub: USER, iat: before })).resolves.toBe(true);
    await expect(svc.isRevoked({ sub: USER, sid: SID_A })).resolves.toBe(true);
    // Entra otra vez (un segundo después): ese token vale.
    vi.setSystemTime(new Date(T0.getTime() + 1_000));
    await expect(svc.isRevoked({ sub: USER, sid: SID_B, iat: sec(T0) + 1 })).resolves.toBe(false);
    // Otra persona, nada.
    await expect(svc.isRevoked({ sub: '7d0f4f9e-0000-4000-8000-0000000000dd', sid: SID_A, iat: before })).resolves.toBe(false);
  });

  it('la marca dura más que cualquier token de acceso emitido antes, y luego se va sola', async () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(3_600);
    expect(ACCESS_REVOCATION_TTL_SECONDS).toBeGreaterThan(ACCESS_TOKEN_TTL_SECONDS);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { svc, redis } = make();
    await svc.revokeSession(SID_A);
    await svc.revokeUser(USER);
    vi.setSystemTime(new Date(T0.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000));
    await expect(svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).resolves.toBe(true);
    vi.setSystemTime(new Date(T0.getTime() + ACCESS_REVOCATION_TTL_SECONDS * 1000 + 1_000));
    expect(redis.keys().filter((k) => k.startsWith('nightpay:access:'))).toEqual([]);
  });

  it('Redis falla o no contesta a tiempo → 503 (no se deja pasar a ciegas; tampoco se cierra la sesión)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, redis } = make();
    vi.spyOn(redis, 'mget').mockRejectedValueOnce(new Error('Connection is closed.'));
    const down = await svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) }).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(ServiceUnavailableException);
    expect((down as ServiceUnavailableException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((down as ServiceUnavailableException).getResponse()).toMatchObject({ code: SESSION_CHECK_UNAVAILABLE_CODE });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(redis, 'mget').mockImplementationOnce(() => new Promise(() => undefined));
    const pending = svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ACCESS_CHECK_TIMEOUT_MS + 1);
    expect(await pending).toBeInstanceOf(ServiceUnavailableException);
  });

  it('con el proceso muy cargado (prueba real: 300 a la vez) se espera a Redis entre 1,5 y 2 s: una respuesta que tarda 1 s deja pasar', async () => {
    // Antes, 500 ms: Redis estaba vivo, pero su respuesta esperaba a que el proceso la atendiera.
    expect(ACCESS_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(1_500);
    expect(ACCESS_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { svc, redis } = make();
    vi.spyOn(redis, 'mget').mockImplementationOnce(
      () => new Promise<Array<string | null>>((resolve) => setTimeout(() => resolve([null, null]), 1_000)),
    );
    const slow = svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(slow).resolves.toBe(false);
  });

  it('el 503 dice cuándo volver a probar (retryAfter → cabecera Retry-After, como DB_BUSY)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, redis } = make();
    vi.spyOn(redis, 'mget').mockRejectedValueOnce(new Error('Connection is closed.'));
    const down = await svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) }).catch((e: unknown) => e);
    expect(SESSION_CHECK_RETRY_AFTER_S).toBe(2);
    expect((down as ServiceUnavailableException).getResponse()).toMatchObject({
      code: SESSION_CHECK_UNAVAILABLE_CODE,
      retryAfter: SESSION_CHECK_RETRY_AFTER_S,
    });
  });

  it('sin inundar el log: un WARN (no ERROR) por tanda, y el siguiente dice cuántos se callaron', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, redis } = make();
    vi.spyOn(redis, 'mget').mockRejectedValue(new Error('Redis no contestó en 2000 ms'));
    const check = () => svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) }).catch((e: unknown) => e);
    for (let i = 0; i < 31; i += 1) expect(await check()).toBeInstanceOf(ServiceUnavailableException);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Redis no contestó en 2000 ms');
    expect(error).not.toHaveBeenCalled();

    // Dentro del mismo intervalo, nada más; pasado, uno con lo que se calló.
    vi.setSystemTime(new Date(T0.getTime() + SESSION_CHECK_WARN_EVERY_MS - 1));
    await check();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0.getTime() + SESSION_CHECK_WARN_EVERY_MS));
    await check();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain('31 más');
  });

  it('avisa a quien escucha (el tiempo real cierra esas conexiones)', async () => {
    const { svc } = make();
    const heard: unknown[] = [];
    const off = svc.onRevoked((r) => heard.push(r));
    await svc.revokeSession(SID_A);
    await svc.revokeUser(USER);
    off();
    await svc.revokeSession(SID_B);
    expect(heard).toEqual([
      { kind: 'session', sid: SID_A },
      { kind: 'user', userId: USER },
    ]);
  });

  it('un oyente que falla no impide revocar', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc } = make();
    svc.onRevoked(() => {
      throw new Error('socket caído');
    });
    await expect(svc.revokeSession(SID_A)).resolves.toBeUndefined();
    await expect(svc.isRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).resolves.toBe(true);
  });
});

describe('AccessRevocationService — lo que este nodo ya sabe revocado (para el límite global, sin Redis)', () => {
  it('nada visto → no se sabe revocado', () => {
    const { svc } = make();
    expect(svc.isKnownRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).toBe(false);
  });

  it('lo que revocó este nodo: la sesión, y los tokens de la persona emitidos antes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { svc } = make();
    await svc.revokeSession(SID_A);
    expect(svc.isKnownRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).toBe(true);
    expect(svc.isKnownRevoked({ sub: USER, sid: SID_B, iat: sec(T0) })).toBe(false);
    await svc.revokeUser(USER);
    expect(svc.isKnownRevoked({ sub: USER, sid: SID_B, iat: sec(T0) - 30 })).toBe(true);
    // Un login después de revocar no se toca.
    expect(svc.isKnownRevoked({ sub: USER, sid: SID_B, iat: sec(T0) + 5 })).toBe(false);
  });

  it('lo que otro nodo revocó, en cuanto una petición lo encuentra en Redis', async () => {
    const other = make();
    const svc = new AccessRevocationService(other.redis as never);
    await other.svc.revokeSession(SID_A);
    const token = { sub: USER, sid: SID_A, iat: sec(T0) };
    expect(svc.isKnownRevoked(token)).toBe(false);
    await expect(svc.isRevoked(token)).resolves.toBe(true);
    expect(svc.isKnownRevoked(token)).toBe(true);
  });

  it('se olvida cuando caduca la marca', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { svc } = make();
    await svc.revokeSession(SID_A);
    vi.setSystemTime(new Date(T0.getTime() + ACCESS_REVOCATION_TTL_SECONDS * 1000 + 1_000));
    expect(svc.isKnownRevoked({ sub: USER, sid: SID_A, iat: sec(T0) })).toBe(false);
  });
});

describe('pnpm cli revoke-sessions escribe las mismas marcas (packages/db/scripts/cli.ts)', () => {
  it('mismas claves y mismo TTL que el API', async () => {
    const cli = readFileSync(join(__dirname, '../../../../../packages/db/scripts/cli.ts'), 'utf8');
    expect(cli).toContain(`const ACCESS_REVOCATION_TTL_SECONDS = ${ACCESS_REVOCATION_TTL_SECONDS};`);
    expect(cli).toContain('`nightpay:access:revoked-before:${userId}`');
    expect(cli).toContain('`nightpay:access:revoked-sid:${sid}`');
    // Y el API las lee con esos nombres.
    const { svc, redis } = make();
    await svc.revokeUser(USER);
    await svc.revokeSession(SID_A);
    expect(redis.keys().sort()).toEqual([`nightpay:access:revoked-before:${USER}`, `nightpay:access:revoked-sid:${SID_A}`]);
  });
});
