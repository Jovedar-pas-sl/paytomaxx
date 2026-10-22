import { defineConfig, devices } from '@playwright/test';

// Only isolated local services. No minted JWTs, patched refreshes or live gateways.
const api = 'http://127.0.0.1:4300';
const admin = 'http://127.0.0.1:4303';
const operator = 'http://127.0.0.1:4301';
export default defineConfig({
  testDir: './tests/ci',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: admin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}) } }],
  webServer: [
    {
      command: 'pnpm --filter @nightpay/api exec tsx src/main.ts',
      cwd: '../..', url: `${api}/v1/health`, timeout: 180_000, reuseExistingServer: false,
      env: { NODE_ENV: 'test', PORT: '4300', CORS_ORIGINS: `${admin},${operator}`, NEXT_PUBLIC_API_URL: api, PEANPE_API_URL: 'http://127.0.0.1:9', PEANPE_WEBHOOK_SECRET: 'isolated-e2e-peanpe', LOG_LEVEL: 'warn' },
    },
    ...([{ name: 'admin', port: 4303, url: admin }, { name: 'operator', port: 4301, url: operator }] as const).map((app) => ({
      command: `pnpm --filter @nightpay/${app.name} exec next dev -p ${app.port} -H 127.0.0.1`,
      cwd: '../..', url: app.url, timeout: 180_000, reuseExistingServer: false,
      env: { NODE_ENV: 'development', NEXT_PUBLIC_API_URL: api, NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:4300', NEXT_TELEMETRY_DISABLED: '1' },
    })),
  ],
});
