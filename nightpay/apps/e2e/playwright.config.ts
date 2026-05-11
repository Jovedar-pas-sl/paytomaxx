import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config para E2E de NightPay.
 *
 * Pre-condiciones (NO se levantan automáticamente — apunta a procesos vivos):
 *   - API en :4100  (pnpm --filter @nightpay/api dev)
 *   - Admin en :4103  (pnpm --filter @nightpay/admin dev)
 *   - Operator en :4101  (pnpm --filter @nightpay/operator dev)
 *   - Web-client en :4102 (pnpm --filter @nightpay/web-client dev)
 *   - Postgres + Redis vía docker compose
 *
 * Seed mínima esperada en DB:
 *   - venue luna-vlc
 *   - owner@nightpay.local (OWNER)
 *   - ana@local.test (OPERATOR, 90% commission)
 *
 * Variables de entorno:
 *   - E2E_API_URL=http://localhost:4100
 *   - E2E_ADMIN_URL=http://localhost:4103
 *   - E2E_OPERATOR_URL=http://localhost:4101
 *   - E2E_WEB_CLIENT_URL=http://localhost:4102
 *   - JWT_SECRET (se reusa del API .env.local para mintear tokens)
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // serializamos para evitar races en seed compartida
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.E2E_ADMIN_URL ?? 'http://localhost:4103',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
