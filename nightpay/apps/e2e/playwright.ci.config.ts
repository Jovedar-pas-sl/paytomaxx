import { defineConfig, devices } from '@playwright/test';

/**
 * El e2e de CI (job `e2e` de .github/workflows/nightpay-ci.yml): solo servicios
 * locales y aislados, sin JWT fabricados, refrescos simulados ni pasarelas de
 * verdad. Espera DATABASE_URL (una base local nightpay_e2e migrada y con
 * fixtures/ci-seed.mjs), REDIS_URL y los secretos de prueba en el entorno.
 *
 * Sin reintentos: la base y los servicios son nuevos en cada job y las
 * pruebas cambian datos (la carta), así que un fallo es un fallo y no se
 * tapa repitiendo. Lo que se repite de verdad está dentro de cada prueba (las
 * esperas de Playwright). Al fallar quedan traza y capturas en el artefacto.
 */
const api = 'http://127.0.0.1:4300';
const admin = 'http://127.0.0.1:4303';
const operator = 'http://127.0.0.1:4301';
export default defineConfig({
  testDir: './tests/ci',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: admin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // next dev compila cada página la primera vez que se pide.
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
      },
    },
  ],
  // El API y las dos webs, nuevos (nunca uno que ya estuviera corriendo). La URL
  // de cada web es también su calentamiento: compila «/» antes de las pruebas.
  webServer: [
    {
      command: 'pnpm --filter @nightpay/api exec tsx src/main.ts',
      cwd: '../..',
      url: `${api}/v1/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test',
        PORT: '4300',
        CORS_ORIGINS: `${admin},${operator}`,
        NEXT_PUBLIC_API_URL: api,
        PEANPE_API_URL: 'http://127.0.0.1:9',
        PEANPE_WEBHOOK_SECRET: 'isolated-e2e-peanpe',
        LOG_LEVEL: 'warn',
      },
    },
    ...([
      { name: 'admin', port: 4303, url: admin },
      { name: 'operator', port: 4301, url: operator },
    ] as const).map((app) => ({
      command: `pnpm --filter @nightpay/${app.name} exec next dev -p ${app.port} -H 127.0.0.1`,
      cwd: '../..',
      url: app.url,
      timeout: 240_000,
      reuseExistingServer: false,
      env: { NODE_ENV: 'development', NEXT_PUBLIC_API_URL: api, NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:4300', NEXT_TELEMETRY_DISABLED: '1' },
    })),
  ],
});
