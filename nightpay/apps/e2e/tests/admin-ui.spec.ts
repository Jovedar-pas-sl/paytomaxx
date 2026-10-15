import { test, expect } from '@playwright/test';
import { loadSeedFromEnv } from '../fixtures/seed';

/**
 * UI smoke tests del admin app — abre el browser, inyecta sesión via localStorage
 * (evitando el flow de password porque no lo conocemos en el dev seed) y verifica
 * que las tabs principales pintan datos sin error.
 */

test.describe('Admin UI @admin', () => {
  test.beforeEach(async ({ page }) => {
    const { owner } = loadSeedFromEnv();
    // Inyectar sesión antes de hidratar React → la página arranca autenticada.
    await page.addInitScript((session: { token: string; user: unknown }) => {
      window.localStorage.setItem('np_admin_token', session.token);
      window.localStorage.setItem('np_admin_refresh', 'fake-refresh-not-used');
      window.localStorage.setItem('np_admin_user', JSON.stringify(session.user));
    }, {
      token: owner.ownerToken,
      user: {
        id: owner.ownerId,
        email: owner.ownerEmail,
        role: 'OWNER',
        tenantId: owner.tenantId,
        venueSlug: owner.venueSlug,
      },
    });
  });

  test('Dashboard pinta sin "Error cargando métricas"', async ({ page }) => {
    await page.goto('/');
    // El dashboard tarda un tick en hidratar + fetch metrics
    await expect(page.locator('body')).not.toContainText('Error cargando métricas', {
      timeout: 8_000,
    });
    // Debería renderizar algún widget de payments
    await expect(page.getByText(/Pagos/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Tab Operadoras carga la lista sin crash', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: /Operadoras/i }).click();
    await expect(page.locator('body')).not.toContainText('Error cargando operadoras', {
      timeout: 5_000,
    });
  });

  test('Tab Treasury muestra metric tiles + EUR→USDT rate', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: /Treasury/i }).click();
    await expect(page.getByText(/EUR.*USDT/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Saldo pendiente/i)).toBeVisible();
  });

  test('Tab Ajustes (Settings) carga el form (OWNER only)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: /Ajustes/i }).click();
    await expect(page.getByText(/comisión|commission/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
