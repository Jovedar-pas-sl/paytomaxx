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

  it('la página de pago, o la app del personal con datáfono (nunca la pasarela dos veces)', () => {
    const urls = { client: 'https://api.oxio.es', operator: 'https://operator.oxio.es' };
    expect(cardQrUrl({ id: 'p1', qrToken: 'tok', captureMethod: null }, urls)).toBe('https://api.oxio.es/pay/tok');
    expect(cardQrUrl({ id: 'p1', qrToken: 'tok', captureMethod: 'POS_EXTERNAL' }, urls)).toBe('https://operator.oxio.es/?pos=p1');
  });
});

describe('/pay con la propina elegida en la pantalla de la barra (?tip=)', () => {
  const choose = { kind: 'choose', amountCents: 3300, tipOptionsCents: [0, 200, 500] } as unknown as PayRedirect;

  it('sale marcada si es una de las que se ofrecen', () => {
    expect(withChosenTip(choose, '500')).toMatchObject({ presetTipCents: 500 });
  });

  it('otra cualquiera, nada, 0 o basura: la página como siempre (nada marcado)', () => {
    for (const raw of [undefined, '0', '700', '-200', 'abc', '2.5']) expect(withChosenTip(choose, raw)).toBe(choose);
    const paid = { kind: 'paid' } as unknown as PayRedirect;
    expect(withChosenTip(paid, '500')).toBe(paid);
  });
});
