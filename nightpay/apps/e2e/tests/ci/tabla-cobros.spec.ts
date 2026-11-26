import { test, expect } from '@playwright/test';

// El tutorial de la primera vez (Tour) tapa la pantalla hasta cerrarlo: aquí se da por visto.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      return key.startsWith('np-tour-') ? '1' : getItem.call(this, key);
    };
  });
});

const row = {
  kind: 'PAYMENT', id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', ref: 'C-0001', confirmationCode: 'A6B',
  createdAt: '2026-10-28T12:00:00Z', amountCents: 5000, tipCents: 200, serviceFeeCents: 500,
  currency: 'EUR', status: 'AUTHORIZED', person: { id: 'test', name: 'Persona de prueba', role: 'WAITER' },
  sections: [{ category: 'VENUE_BAR', amountCents: 5000 }], isTopUp: false, method: 'CARD', methodLabel: 'Tarjeta',
  wallet: null, service: 'Consumo de prueba', invited: null, lines: [], paidTwice: null,
  payment: { availableAmountCents: 5000, provider: 'REDSYS', providerTxId: 'ORDEN123', captureMethod: null,
    updatedAt: '2026-10-28T12:00:00Z', authCode: '012345', cardLast4: null, cardBrand: null,
    payMethodCode: null, authorizedAt: '2026-10-28T12:00:00Z', attempts: [], terminal: {externalId:'TEST',label:'Barra'} },
};

test('los botones del cobro quedan visibles y se pueden usar en móvil, tableta y ordenador', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 806, height: 900 });
  await page.route('**/v1/admin/cobros?*', route => route.fulfill({ status: 200, contentType:'application/json',
    headers: { 'Access-Control-Allow-Origin':'http://127.0.0.1:4303', 'Access-Control-Allow-Credentials':'true' },
    body: JSON.stringify({ items: [row], nextCursor: null }) }));
  await page.goto('/');
  await page.getByLabel(/^(Email|Correo electrónico)$/).fill('owner@isolated.test');
  await page.getByLabel('Contraseña', { exact: true }).fill('Isolated-test-password-2026!');
  await page.getByRole('button',{ name:'Entrar',exact:true }).click();
  await page.getByText(/esta noche/i).first().waitFor();
  await page.goto('/?s=hoy&t=cobros');
  const detail = page.getByRole('button', { name: 'Ver detalle', exact: true });
  const refund = page.getByRole('button', { name: 'Devolución BBVA', exact: true });
  await expect(detail).toBeVisible();
  for (const width of [806, 1024, 1440, 390]) {
    await page.setViewportSize({width,height:900});
    for (const button of [detail, refund]) {
      const box = await button.boundingBox();
      expect(box, 'falta el botón').not.toBeNull();
      expect(box!.x, 'botón fuera por la izquierda').toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, 'botón cortado por la derecha').toBeLessThanOrEqual(width);
    }
    if (width === 806 || width === 390) await page.screenshot({path: testInfo.outputPath(`tabla-${width}.png`), fullPage: true});
    await detail.click();
    await expect(page.getByRole('dialog',{ name:'Detalle del cobro' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Cerrar'}).click();
    await refund.click();
    await expect(page.getByRole('dialog',{name:'Registrar devolución de BBVA'})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'Cerrar'}).click();
  }
});
