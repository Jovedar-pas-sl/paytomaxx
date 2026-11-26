import { test, expect, type APIRequestContext } from '@playwright/test';

// El tutorial de la primera vez (Tour) tapa la pantalla hasta cerrarlo: aquí se da por visto.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      return key.startsWith('np-tour-') ? '1' : getItem.call(this, key);
    };
  });
});

/**
 * Recorridos esenciales con servicios de verdad (playwright.ci.config.ts):
 * base nightpay_e2e recién migrada con los datos de fixtures/ci-seed.mjs, el
 * API y las webs levantados para la prueba. Sin JWT fabricados ni refrescos
 * simulados. Cada job de CI empieza de cero, así que las cifras son exactas.
 */
const api = 'http://127.0.0.1:4300';
const operator = 'http://127.0.0.1:4301';
const password = 'Isolated-test-password-2026!';
/** Productos de la carta de referencia (packages/contracts/src/carta-template.ts). */
const TEMPLATE_PRODUCTS = 12;

async function applyTemplate(request: APIRequestContext, accessToken: string) {
  const res = await request.post(`${api}/v1/services/template`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { confirm: true },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { created: number; updated: number; kept: number; skipped: number };
}

test('login real con cookie, carta de referencia atómica y repetible, y el total de la cuenta en la app', async ({ page }) => {
  // Panel: login de verdad; el refresh va en una cookie HttpOnly, no en el cuerpo.
  await page.goto('/');
  await page.getByRole('textbox', { name: /^(Email|Correo electrónico)$/ }).fill('owner@isolated.test');
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const loginResponse = page.waitForResponse(`${api}/v1/auth/login`);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  const response = await loginResponse;
  expect(response.status()).toBe(200);
  const login = await response.json();
  expect(login.refreshToken).toBeUndefined();
  const cookies = await page.context().cookies(`${api}/v1/auth/refresh`);
  expect(cookies).toEqual(expect.arrayContaining([expect.objectContaining({ httpOnly: true, path: '/v1/auth' })]));

  // La carta de referencia: dos dueños a la vez la aplican una sola vez; repetirla no añade nada.
  const both = await Promise.all([applyTemplate(page.request, login.accessToken), applyTemplate(page.request, login.accessToken)]);
  expect(both.map((r) => r.created).sort((a, b) => a - b)).toEqual([0, TEMPLATE_PRODUCTS]);
  expect(await applyTemplate(page.request, login.accessToken)).toEqual({ created: 0, updated: 0, kept: TEMPLATE_PRODUCTS, skipped: 0 });

  // La cookie de verdad recupera la sesión al recargar (sin simular /auth/refresh).
  const refreshed = page.waitForResponse(`${api}/v1/auth/refresh`);
  await page.reload();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toHaveCount(0);

  // App del personal: la carta aplicada; «Copa con invitación» es una loseta más, justo después de «Copa».
  await page.goto(`${operator}/`);
  await page.getByLabel('Email').fill('waiter@isolated.test');
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  const copa = page.getByRole('button', { name: /^Copa, 10,00\s€/ });
  const invitacion = page.getByRole('button', { name: /^Copa con invitación, 20,00\s€/ });
  await expect(copa).toBeVisible();
  await expect(invitacion).toBeVisible();
  const tiles = await page.getByRole('button', { name: /^(Copa|Copa con invitación|Botella), / }).allTextContents();
  expect(tiles.map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
    expect.stringContaining('Copa10'),
    expect.stringContaining('Copa con invitación20'),
    expect.stringContaining('Botella120'),
  ]);
  // «Copa» es la copa normal: cada toque la suma a la cuenta, sin preguntar nada.
  await copa.click();
  await copa.click();
  await page.getByRole('button', { name: /^Tabla ibérica, 30,00\s€/ }).click();
  await expect(page.getByRole('button', { name: /Cobrar\s*50\s*€/ })).toBeVisible();
  // «Copa con invitación» abre el escáner del QR de la chica (y volver deja la cuenta como estaba).
  await invitacion.click();
  await expect(page.getByRole('heading', { name: 'Escanea el QR de la chica' })).toBeVisible();
  await page.getByRole('button', { name: 'Atrás' }).click();
  await expect(page.getByRole('button', { name: /Cobrar\s*50\s*€/ })).toBeVisible();
});

test('las rutas privadas del saldo no se leen sin desbloquear, tampoco la antigua ni el pase de Google', async ({ request }) => {
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
