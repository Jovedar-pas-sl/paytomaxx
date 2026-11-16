import { describe, it, expect } from 'vitest';
import { cardQrUrl, publicBaseUrls } from './pay-qr-url';

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
