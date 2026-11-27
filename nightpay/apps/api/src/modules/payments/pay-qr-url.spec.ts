import { describe, it, expect } from 'vitest';
import { cardQrUrl, publicBaseUrls } from './pay-qr-url';
import { withChosenTip, type PayRedirect } from './pay-redirect';

describe('el enlace del QR de un cobro con tarjeta', () => {
  it('la web del cliente si la hay; si no, el API (vacío cuenta como sin configurar)', () => {
    expect(publicBaseUrls({ NEXT_PUBLIC_API_URL: 'api.oxio.es/', NEXT_PUBLIC_WEB_CLIENT_URL: ' ' })).toEqual({
      api: 'https://api.oxio.es',
      client: 'https://api.oxio.es',
      operator: 'https://operator.oxio.es',
    });
    expect(publicBaseUrls({ NEXT_PUBLIC_API_URL: 'https://api.oxio.es', NEXT_PUBLIC_WEB_CLIENT_URL: 'https://pagar.oxio.es' }).client).toBe(
      'https://pagar.oxio.es',
    );
    expect(publicBaseUrls({ PORT: '4999' }).api).toBe('http://localhost:4999');
  });

  it('idea 72: la tarjeta, directa a la página de pago del API (urls.api; nunca a la web del cliente, aunque la haya); el datáfono, la app del personal (nunca la pasarela dos veces)', () => {
    const urls = { api: 'https://api.oxio.es', operator: 'https://operator.oxio.es' };
    expect(cardQrUrl({ id: 'p1', qrToken: 'tok', captureMethod: null }, urls)).toBe('https://api.oxio.es/pay/tok');
    expect(cardQrUrl({ id: 'p1', qrToken: 'tok', captureMethod: 'POS_EXTERNAL' }, urls)).toBe('https://operator.oxio.es/?pos=p1');
    // Con la web del cliente configurada, el QR sigue yendo al API (sin el salto que perdía ?tip=).
    const withClient = publicBaseUrls({ NEXT_PUBLIC_API_URL: 'https://api.oxio.es', NEXT_PUBLIC_WEB_CLIENT_URL: 'https://pagar.oxio.es' });
    expect(cardQrUrl({ id: 'p1', qrToken: 'tok', captureMethod: null }, withClient)).toBe('https://api.oxio.es/pay/tok');
  });
});

describe('/pay con la propina elegida en la pantalla de la barra (?tip=): solo si el servidor la tiene apuntada', () => {
  const choose = { kind: 'choose', amountCents: 3300, tipOptionsCents: [0, 200, 500], tipMaxCents: 3300 } as unknown as PayRedirect;
  const fromScreen = (cents: number): PayRedirect => ({ ...choose, screenTipCents: cents }) as PayRedirect;

  it('?tip=500 sin apunte de la pantalla (un QR escrito a mano): nada marcado', () => {
    expect(withChosenTip(choose, '500')).toBe(choose);
  });

  it('apunte 500 y ?tip=500: sale marcada y con su aviso', () => {
    expect(withChosenTip(fromScreen(500), '500')).toMatchObject({ presetTipCents: 500, presetFromScreen: true, tipOptionsCents: [0, 200, 500] });
  });

  it('apunte 200 y ?tip=500 (la cambió después en la pantalla, o no es la suya): nada marcado', () => {
    const view = fromScreen(200);
    expect(withChosenTip(view, '500')).toBe(view);
  });

  it('«Otra» de la tablet (euros enteros hasta el tope), apuntada: un botón más, marcado y con su aviso', () => {
    expect(withChosenTip(fromScreen(700), '700')).toMatchObject({ presetTipCents: 700, presetFromScreen: true, tipOptionsCents: [0, 200, 500, 700] });
  });

  it('céntimos sueltos, por encima del tope, nada, 0 o basura: la página como siempre (nada marcado)', () => {
    for (const raw of [undefined, '0', '750', '3400', '-200', 'abc', '2.5']) {
      expect(withChosenTip(choose, raw)).toBe(choose);
      const cents = Number(raw);
      if (Number.isInteger(cents) && cents > 0) {
        const view = fromScreen(cents);
        expect(withChosenTip(view, raw)).toBe(view);
      }
    }
    const paid = { kind: 'paid' } as unknown as PayRedirect;
    expect(withChosenTip(paid, '500')).toBe(paid);
  });
});
