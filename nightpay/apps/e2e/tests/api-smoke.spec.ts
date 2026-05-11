import { test, expect } from '@playwright/test';
import { apiFetch, apiJson, mintToken } from '../fixtures/auth';
import { loadSeedFromEnv } from '../fixtures/seed';

/**
 * Smoke tests del API a través de HTTP — sin abrir browser todavía.
 * Cubren los caminos críticos del backend: auth, tenant filtering, treasury.
 */

test.describe('API smoke @api', () => {
  test('GET /v1/admin/metrics returns 200 with OWNER token', async () => {
    const { owner } = loadSeedFromEnv();
    const res = await apiFetch('/v1/admin/metrics', { token: owner.ownerToken });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('today');
    expect(body).toHaveProperty('week');
  });

  test('GET /v1/admin/metrics returns 401 without token', async () => {
    const res = await apiFetch('/v1/admin/metrics');
    expect(res.status).toBe(401);
  });

  test('GET /v1/admin/metrics returns 401 with malformed token', async () => {
    const res = await apiFetch('/v1/admin/metrics', { token: 'garbage.token.here' });
    expect(res.status).toBe(401);
  });

  test('GET /v1/admin/operators lists operadoras with new onboarding fields', async () => {
    const { owner } = loadSeedFromEnv();
    const operators = await apiJson<
      Array<{
        id: string;
        email: string;
        onboardingStatus?: string;
        walletProvider?: string | null;
        payoutMethod?: string | null;
      }>
    >('/v1/admin/operators', { token: owner.ownerToken });
    expect(Array.isArray(operators)).toBe(true);
    if (operators.length > 0) {
      const first = operators[0];
      expect(first).toHaveProperty('onboardingStatus');
      expect(first).toHaveProperty('walletProvider');
      expect(first).toHaveProperty('payoutMethod');
    }
  });

  test('GET /v1/admin/treasury/stats returns valid structure', async () => {
    const { owner } = loadSeedFromEnv();
    const stats = await apiJson<{
      pendingPayoutsCents: number;
      pendingOperatorCount: number;
      payoutsThisMonthCount: number;
      payoutsThisMonthCents: number;
      byMethod: Record<string, number>;
      byReconciliationStatus: Record<string, number>;
    }>('/v1/admin/treasury/stats', { token: owner.ownerToken });
    expect(typeof stats.pendingPayoutsCents).toBe('number');
    expect(typeof stats.pendingOperatorCount).toBe('number');
    expect(stats.byMethod).toBeDefined();
    expect(stats.byReconciliationStatus).toBeDefined();
  });

  test('GET /v1/admin/treasury/exchange-rate returns rate + degraded flag', async () => {
    const { owner } = loadSeedFromEnv();
    const rate = await apiJson<{
      pair: string;
      rate: number;
      at: string;
      degraded: boolean;
    }>('/v1/admin/treasury/exchange-rate', { token: owner.ownerToken });
    expect(rate.pair).toBe('EUR/USDT');
    expect(rate.rate).toBeGreaterThan(0);
    expect(rate.rate).toBeLessThan(2);
    expect(typeof rate.degraded).toBe('boolean');
  });

  test('MANAGER token cannot edit commissionBps (OWNER-only field)', async () => {
    const { owner } = loadSeedFromEnv();
    const managerToken = mintToken({
      sub: owner.ownerId,
      email: 'manager@e2e.test',
      role: 'MANAGER',
      tenantId: owner.tenantId,
      venueSlug: owner.venueSlug,
    });
    // Buscar un operator id real para el path param
    const operators = await apiJson<Array<{ id: string }>>(
      '/v1/admin/operators',
      { token: owner.ownerToken },
    );
    if (operators.length === 0) {
      test.skip(true, 'No hay operadoras en el dev DB — saltando');
      return;
    }
    const res = await apiFetch(`/v1/admin/operators/${operators[0].id}`, {
      method: 'PATCH',
      token: managerToken,
      body: JSON.stringify({ commissionBps: 9500 }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/commissionBps/);
  });

  test('MANAGER token CAN edit onboarding fields (no financial impact)', async () => {
    const { owner } = loadSeedFromEnv();
    const managerToken = mintToken({
      sub: owner.ownerId,
      email: 'manager@e2e.test',
      role: 'MANAGER',
      tenantId: owner.tenantId,
      venueSlug: owner.venueSlug,
    });
    const operators = await apiJson<Array<{ id: string; onboardingNotes?: string | null }>>(
      '/v1/admin/operators',
      { token: owner.ownerToken },
    );
    if (operators.length === 0) {
      test.skip(true, 'No hay operadoras — saltando');
      return;
    }
    const stamp = `E2E-${Date.now()}`;
    const res = await apiFetch(`/v1/admin/operators/${operators[0].id}`, {
      method: 'PATCH',
      token: managerToken,
      body: JSON.stringify({ onboardingNotes: stamp }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.onboardingNotes).toBe(stamp);
  });
});

test.describe('IP rate-limit @security', () => {
  test('exceeds login rate limit → 429 with Retry-After', async () => {
    // Login endpoint tiene @IpRateLimit({max:10, windowSec:60}) — 11 requests
    // del mismo IP deben triggerar el guard. Como localhost está en allowList
    // del rate-limit global, este test podría no fallar — depende del entorno.
    // Para CI conviene un proxy o un IP X-Forwarded-For real.
    const responses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await apiFetch('/v1/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.99' },
        body: JSON.stringify({
          email: 'nobody@e2e.test',
          password: 'wrong-on-purpose',
          venueSlug: 'luna-vlc',
        }),
      });
      responses.push(res.status);
    }
    // Deberíamos ver al menos un 429 al final
    expect(responses.some((s) => s === 429)).toBe(true);
  });
});
