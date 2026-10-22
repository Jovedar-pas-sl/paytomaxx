import { test, expect } from '@playwright/test';

const api = 'http://127.0.0.1:4300';
const password = 'Isolated-test-password-2026!';

test('real staff login, atomic catalogue, visible prices and cart total survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill('owner@isolated.test');
  await page.getByLabel('Contraseña').fill(password);
  const loginResponse = page.waitForResponse(`${api}/v1/auth/login`);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  const response = await loginResponse;
  expect(response.status()).toBe(200);
  const login = await response.json();
  expect(login.refreshToken).toBeUndefined();
  const cookies = await page.context().cookies(`${api}/v1/auth/refresh`);
  expect(cookies).toEqual(expect.arrayContaining([expect.objectContaining({ httpOnly: true, path: '/v1/auth' })]));
  const apply = await page.request.post(`${api}/v1/services/template`, { headers: { Authorization: `Bearer ${login.accessToken}` }, data: { confirm: true } });
  expect(apply.status()).toBe(201);
  // A Playwright retry may follow an earlier successful application.
  expect([0, 13]).toContain((await apply.json()).created);
  const again = await page.request.post(`${api}/v1/services/template`, { headers: { Authorization: `Bearer ${login.accessToken}` }, data: { confirm: true } });
  expect(again.status()).toBe(201);
  expect(await again.json()).toMatchObject({ created: 0 });
  // A genuine refresh cookie restores the staff session, without mocking /auth/refresh.
  const refreshed = page.waitForResponse(`${api}/v1/auth/refresh`);
  await page.reload();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toHaveCount(0);

  await page.goto('http://127.0.0.1:4301/');
  await page.getByLabel('Email').fill('waiter@isolated.test');
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  const copa = page.getByRole('button').filter({ has: page.getByText('Copa', { exact: true }) });
  await expect(copa).toBeVisible();
  await copa.click(); await copa.click();
  await page.getByRole('button').filter({ has: page.getByText('Tabla ibérica', { exact: true }) }).click();
  await expect(page.getByRole('button', { name: /Cobrar\s*50\s*€/ })).toBeVisible();
});

test('private wallet routes reject anonymous reads, including legacy JSON and Google pass creation', async ({ request }) => {
  const token = 'isolated-private-wallet-token';
  for (const path of [`/w/${token}/state`, `/v1/wallets/public/${token}`]) {
    const response = await request.get(api + path);
    expect(response.status()).toBe(401);
    expect(await response.text()).not.toContain('12345');
  }
  expect((await request.post(`${api}/w/${token}/google-wallet`, { data: {} })).status()).toBe(401);
  const html = await request.get(`${api}/w/card/isolated-public-card-token`);
  expect(html.status()).toBe(200);
  expect(await html.text()).not.toContain(token);
});
