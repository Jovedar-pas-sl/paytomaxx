import { describe, it, expect } from 'vitest';
import { scrubBreadcrumb, scrubSensitive } from './sentry';

const TG = 'https://api.telegram.org/bot123456:AAH-secret_x/sendMessage';

describe('Sentry: nada de secretos en lo que se envía', () => {
  it('breadcrumbs de llamadas salientes: token de Telegram en la ruta y apikey en la query', () => {
    const crumb = scrubBreadcrumb({
      category: 'http',
      message: `POST ${TG}`,
      data: { url: TG, method: 'POST', 'http.query': 'apikey=K3Y', status_code: 200 },
    });
    expect(JSON.stringify(crumb)).not.toMatch(/AAH-secret_x|K3Y/);
    expect(crumb.data?.url).toBe('https://api.telegram.org/bot***/sendMessage');
    expect(crumb.data?.method).toBe('POST');
  });

  it('eventos de error: petición, cabeceras, cuerpo y breadcrumbs', () => {
    const event = scrubSensitive({
      request: {
        url: 'https://api.paytomaxx.com/s/QrTok/pay?token=x',
        headers: { Authorization: 'Bearer jwt', Cookie: 'c=1', 'x-origin-auth': 'sec', accept: 'json' },
        data: { pin: '1234', secret: 's', tokenizationData: { t: 1 }, Ds_Signature: 'sig', amount: 5 },
        query_string: 'token=x',
      },
      breadcrumbs: [{ data: { url: 'https://api.bscscan.com/api?module=a&apikey=K3Y' } }],
    });
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/QrTok|jwt|c=1|"sec"|1234|"sig"|K3Y/);
    expect(text).toContain('"amount":5');
    expect(text).toContain('"accept":"json"');
  });

  it('trazas: URL y descripción de cada span', () => {
    const event = scrubSensitive({
      transaction: 'GET /w/tok123/state',
      spans: [{ description: `POST ${TG}`, data: { 'http.url': TG, 'url.full': TG, 'http.query': 'api-key=H' } }],
      contexts: { trace: { data: { url: '/pay/qr-abc' } } },
    });
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/AAH-secret_x|tok123|qr-abc|"H"/);
    expect(event?.transaction).toBe('GET /w/***/state');
  });
});
