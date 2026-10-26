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

describe('Sentry: cuerpos con 2FA, tickets y llaves (SEC-06)', () => {
  const LOGIN_TOTP = { loginTicket: 'tkt-0123456789', totpCode: '123456', lang: 'es' };
  const SECRETS = /tkt-0123456789|123456|AuThDaTa|sIgNaTuRe|K7Q4M2|pass-tok|card-77|"s3cr3t"|wallet-tok|n3wPass/;

  it('login con 2FA, cambio de local, códigos y passkeys: fuera aunque estén en un objeto anidado', () => {
    const event = scrubSensitive({
      request: {
        data: {
          ...LOGIN_TOTP,
          code: '123456',
          walletToken: 'pass-tok',
          ref: { code: 'K7Q4M2', card: 'card-77' },
          passkey: { id: 'cred-1', response: { authenticatorData: 'AuThDaTa', signature: 'sIgNaTuRe' } },
          items: [{ newPassword: 'n3wPass', amount: 3 }],
          deep: { a: { b: { c: { d: { secret: 's3cr3t' } } } } },
          amountCents: 4500,
        },
      },
    });
    const text = JSON.stringify(event);
    expect(text).not.toMatch(SECRETS);
    expect(text).toContain('"lang":"es"');
    expect(text).toContain('"amountCents":4500');
    expect(text).toContain('"amount":3');
  });

  it('el cuerpo como texto (así lo guarda el SDK de Sentry): JSON limpio por dentro', () => {
    const event = scrubSensitive({ request: { data: JSON.stringify({ ...LOGIN_TOTP, password: 'p4ss' }) } });
    const data = (event.request as { data: string }).data;
    expect(data).not.toMatch(/tkt-0123456789|123456|p4ss/);
    expect(JSON.parse(data)).toMatchObject({ lang: 'es', totpCode: '[REDACTED]' });
  });

  it('el cuerpo como texto de formulario (avisos de Redsys): fuera las claves sensibles', () => {
    const event = scrubSensitive({
      request: { data: 'Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=eyJBQkMi&Ds_Signature=sIgNaTuRe' },
    });
    const data = (event.request as { data: string }).data;
    expect(data).not.toMatch(/eyJBQkMi|sIgNaTuRe/);
    expect(data).toContain('Ds_SignatureVersion=HMAC_SHA256_V1');
  });

  it('texto que no es ni JSON ni formulario: no se manda', () => {
    const event = scrubSensitive({ request: { data: 'algo raro con el pin 1234' } });
    expect((event.request as { data: string }).data).toBe('[REDACTED]');
  });

  it('un objeto que se contiene a sí mismo no cuelga la limpieza', () => {
    const body: Record<string, unknown> = { totpCode: '123456' };
    body.self = body;
    expect(JSON.stringify(scrubSensitive({ request: { data: body } }), (_k, v) => (v === body ? undefined : v))).not.toContain(
      '123456',
    );
  });
});
