import { describe, it, expect, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { GLOBAL_LIMITS, createGlobalRateLimit, isGlobalRateLimitExempt } from './global-rate-limit';

/**
 * Límite global (SEC-02): todo el local sale por la misma IP. Con la sesión
 * del personal válida se cuenta por persona (y un tope por local); sin ella,
 * por IP. Un token inventado o caducado no da cupo propio.
 */

const SECRET = 'secreto-de-las-pruebas-0123456789abcdef0123';
const VENUE_A = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const VENUE_B = '6c1d9f8e-3e2b-4d4c-8f9a-1b2c3d4e5f60';
const ANA = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const LUIS = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const IP = '81.0.0.7';

const jwt = new JwtService({ secret: SECRET });

function staffToken(sub: string, tenantId: string, opts: { secret?: string; expiresIn?: number; extra?: object } = {}) {
  return jwt.sign(
    { sub, email: `${sub.slice(0, 4)}@local.es`, role: 'WAITER', tenantId, venueSlug: 'sala', sid: 's-1', ...opts.extra },
    { secret: opts.secret ?? SECRET, expiresIn: opts.expiresIn ?? 3600 },
  );
}

function req(token?: string, url = '/v1/payments', method = 'GET') {
  return {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    raw: { socket: { remoteAddress: IP } },
  };
}

function limiter(limits: Partial<typeof GLOBAL_LIMITS> = {}, start = Date.UTC(2026, 9, 26, 22, 0, 0)) {
  let now = start;
  const onLimited = vi.fn();
  const rl = createGlobalRateLimit({ jwtSecret: SECRET, limits, now: () => now, onLimited });
  /** Lo que haría el plugin: la clave y el tope de esa petición. */
  const decide = async (r: ReturnType<typeof req>) => {
    const key = await rl.keyGenerator(r as never);
    return { key, max: await rl.max(r as never, key) };
  };
  return { rl, decide, onLimited, advance: (ms: number) => (now += ms) };
}

describe('límite global: de quién es la petición', () => {
  it('sin sesión: por IP (de fiar), con el tope de los anónimos', async () => {
    const { decide } = limiter();
    await expect(decide(req())).resolves.toEqual({ key: `ip:${IP}`, max: GLOBAL_LIMITS.ip });
  });

  it('con la sesión del personal: por persona, con su tope (el wifi del local no cuenta)', async () => {
    const { decide } = limiter();
    await expect(decide(req(staffToken(ANA, VENUE_A)))).resolves.toEqual({ key: `user:${ANA}`, max: GLOBAL_LIMITS.user });
    await expect(decide(req(staffToken(LUIS, VENUE_A)))).resolves.toEqual({ key: `user:${LUIS}`, max: GLOBAL_LIMITS.user });
  });

  it('un token inventado, caducado, de un solo uso o mal formado cuenta como anónimo (no da cupo propio)', async () => {
    const { decide } = limiter();
    for (const token of [
      staffToken(ANA, VENUE_A, { secret: 'otro-secreto-que-no-es-el-del-api-000000000' }),
      staffToken(ANA, VENUE_A, { expiresIn: -10 }),
      staffToken(ANA, VENUE_A, { extra: { purpose: 'invite' } }),
      jwt.sign({ sub: 'no-es-un-uuid' }, { secret: SECRET }),
      'basura',
    ]) {
      await expect(decide(req(token))).resolves.toEqual({ key: `ip:${IP}`, max: GLOBAL_LIMITS.ip });
    }
    const raw = { ...req(), headers: { authorization: `Basic ${staffToken(ANA, VENUE_A)}` } };
    await expect(decide(raw)).resolves.toMatchObject({ key: `ip:${IP}` });
  });

  it('los topes: anónimos 300/min por IP, cada persona 600/min, cada local 6000/min', () => {
    expect(GLOBAL_LIMITS).toEqual({ ip: 300, user: 600, venue: 6000 });
  });
});

describe('límite global: tope por local', () => {
  it('pasado el tope del local, todas sus personas esperan; otro local sigue', async () => {
    const { decide } = limiter({ venue: 3 });
    const ana = req(staffToken(ANA, VENUE_A));
    const luis = req(staffToken(LUIS, VENUE_A));
    expect((await decide(ana)).max).toBe(GLOBAL_LIMITS.user);
    expect((await decide(luis)).max).toBe(GLOBAL_LIMITS.user);
    expect((await decide(ana)).max).toBe(GLOBAL_LIMITS.user);
    // La 4.ª del local: tope 0 → el plugin responde 429 como con cualquier límite.
    expect((await decide(luis)).max).toBe(0);
    expect((await decide(req(staffToken(LUIS, VENUE_B)))).max).toBe(GLOBAL_LIMITS.user);
  });

  it('en el minuto siguiente vuelve a empezar', async () => {
    const { decide, advance } = limiter({ venue: 1 });
    const ana = req(staffToken(ANA, VENUE_A));
    await decide(ana);
    expect((await decide(ana)).max).toBe(0);
    advance(60_000);
    expect((await decide(ana)).max).toBe(GLOBAL_LIMITS.user);
  });

  it('un solo token en bucle no llena el local: lo que pasa del tope de su persona no cuenta en el del local', async () => {
    const { decide } = limiter({ user: 3, venue: 5 });
    const ana = req(staffToken(ANA, VENUE_A));
    // Ana manda 10: el plugin rechaza de la 4.ª en adelante (su tope), y esas no suman al local.
    for (let i = 0; i < 10; i++) expect((await decide(ana)).max).toBe(3);
    const luis = req(staffToken(LUIS, VENUE_A));
    // Al local le quedan 2 (5 − las 3 de Ana): Luis trabaja.
    expect((await decide(luis)).max).toBe(3);
    expect((await decide(luis)).max).toBe(3);
    expect((await decide(luis)).max).toBe(0);
  });

  it('el bucle de una persona tampoco le cuenta en el minuto siguiente más que su tope', async () => {
    const { decide, advance } = limiter({ user: 2, venue: 3 });
    const ana = req(staffToken(ANA, VENUE_A));
    for (let i = 0; i < 50; i++) await decide(ana);
    advance(60_000);
    for (let i = 0; i < 50; i++) await decide(ana);
    // 2 de Ana en este minuto: a Luis le queda 1.
    const luis = req(staffToken(LUIS, VENUE_A));
    expect((await decide(luis)).max).toBe(2);
    expect((await decide(luis)).max).toBe(0);
  });

  it('un token ya revocado (lo sabe este nodo) tiene su cupo pero no cuenta en el del local', async () => {
    const revoked = new Set([ANA]);
    const rl = createGlobalRateLimit({
      jwtSecret: SECRET,
      limits: { user: 100, venue: 2 },
      now: () => Date.UTC(2026, 9, 26, 22, 0, 0),
      isKnownRevoked: (t) => revoked.has(t.sub),
    });
    const decide = async (r: ReturnType<typeof req>) => {
      const key = await rl.keyGenerator(r as never);
      return { key, max: await rl.max(r as never, key) };
    };
    const ana = req(staffToken(ANA, VENUE_A));
    for (let i = 0; i < 20; i++) await expect(decide(ana)).resolves.toEqual({ key: `user:${ANA}`, max: 100 });
    const luis = req(staffToken(LUIS, VENUE_A));
    expect((await decide(luis)).max).toBe(100);
    expect((await decide(luis)).max).toBe(100);
    expect((await decide(luis)).max).toBe(0);
  });

  it('al pasarse avisa de qué tope fue (métrica de 429)', async () => {
    const { rl, decide, onLimited } = limiter({ venue: 1 });
    const anon = req();
    rl.onExceeded(anon as never, (await decide(anon)).key);
    const ana = req(staffToken(ANA, VENUE_A));
    rl.onExceeded(ana as never, (await decide(ana)).key);
    rl.onExceeded(ana as never, (await decide(ana)).key);
    expect(onLimited.mock.calls.map((c) => c[0])).toEqual(['ip', 'user', 'venue']);
  });
});

describe('límite global: el sondeo del cobro va con su propio límite', () => {
  it('GET /v1/payments/public/<qr> (lo sondean las apps del personal sin sesión) no cuenta en el global', () => {
    expect(isGlobalRateLimitExempt(req(undefined, '/v1/payments/public/qr-tok-1'))).toBe(true);
    expect(isGlobalRateLimitExempt(req(undefined, '/v1/payments/public/qr-tok-1?x=1'))).toBe(true);
  });

  it('el resto de esa ruta sí cuenta', () => {
    expect(isGlobalRateLimitExempt(req(undefined, '/v1/payments/public/qr-tok-1', 'POST'))).toBe(false);
    expect(isGlobalRateLimitExempt(req(undefined, '/v1/payments/public/qr-tok-1/start-authorization', 'POST'))).toBe(false);
    expect(isGlobalRateLimitExempt(req(undefined, '/v1/payments/public/qr-tok-1/peanpe-redirect-url'))).toBe(false);
    expect(isGlobalRateLimitExempt(req(undefined, '/v1/payments/public/'))).toBe(false);
  });
});
