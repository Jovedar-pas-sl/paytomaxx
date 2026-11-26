import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { httpLoggerOptions } from './logger-options';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream };
}

/**
 * Cada línea del log sin lo que cambia en cada ejecución (pid, hora,
 * máquina): un pid 12349 contenía «1234» y la prueba fallaba por casualidad.
 */
function withoutRunInfo(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => {
    const { pid: _pid, time: _time, hostname: _hostname, ...rest } = JSON.parse(line) as Record<string, unknown>;
    return rest;
  });
}

/** Secretos que no pueden salir por casualidad en otra parte del log (ni unos dentro de otros). */
const SECRET = {
  jwt: 'S3CRETO-JWT',
  cookie: 'S3CRETO-COOKIE',
  originAuth: 'S3CRETO-CLOUDFLARE',
  pin: 'S3CRETO-PIN-UNO',
  pin2: 'S3CRETO-PIN-DOS',
  password: 'S3CRETO-CLAVE',
  secret: 'S3CRETO-GENERICO',
  tokenizationData: 'S3CRETO-TARJETA',
  merchantParameters: 'S3CRETO-PARAMETROS',
  signature: 'S3CRETO-FIRMA',
} as const;

describe('logger HTTP (pino de Fastify)', () => {
  it('tapa cabeceras de sesión, el secreto de Cloudflare y campos sensibles', () => {
    const { lines, stream } = capture();
    const { serializers: _serializers, ...options } = httpLoggerOptions('info');
    const log = pino(options, stream);
    log.info(
      {
        req: {
          headers: {
            authorization: `Bearer ${SECRET.jwt}`,
            cookie: `sid=${SECRET.cookie}`,
            'x-origin-auth': SECRET.originAuth,
            accept: 'json',
          },
        },
        body: {
          pin: SECRET.pin,
          pin2: SECRET.pin2,
          password: SECRET.password,
          secret: SECRET.secret,
          tokenizationData: SECRET.tokenizationData,
          amount: 5,
        },
        redsys: { Ds_MerchantParameters: SECRET.merchantParameters, Ds_Signature: SECRET.signature },
      },
      'petición',
    );
    const entries = withoutRunInfo(lines);
    const out = JSON.stringify(entries);
    for (const value of Object.values(SECRET)) expect(out).not.toContain(value);
    expect(out).toContain('"accept":"json"');
    expect(out).toContain('"amount":5');
    // Tapados (no quitados): se ve que estaban.
    expect(entries[0]).toMatchObject({
      req: { headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', 'x-origin-auth': '[REDACTED]' } },
      body: {
        pin: '[REDACTED]',
        pin2: '[REDACTED]',
        password: '[REDACTED]',
        secret: '[REDACTED]',
        tokenizationData: '[REDACTED]',
      },
      redsys: { Ds_MerchantParameters: '[REDACTED]', Ds_Signature: '[REDACTED]' },
    });
  });

  it('la URL de cada petición sale sin tokens y con la IP de fiar', () => {
    const { serializers } = httpLoggerOptions('info');
    const out = serializers.req({
      method: 'GET',
      url: '/w/tok123/state',
      headers: { 'cf-connecting-ip': '1.1.1.1' },
      raw: { socket: { remoteAddress: '81.0.0.7' } },
    });
    expect(out).toEqual({ method: 'GET', url: '/w/***/state', hostname: undefined, remoteAddress: '81.0.0.7' });
  });
});

describe('logger HTTP: API de socios', () => {
  it('qr, nfc_uid, description y la clave sellada del enlace salen tapados', () => {
    const { lines, stream } = capture();
    const { serializers: _serializers, ...options } = httpLoggerOptions('info');
    pino(options, stream).info({
      body: { qr: 'https://x.example/?ficha=S3CRETO-QR', nfc_uid: '04A1B2C3D4E5F6', description: 'S3CRETO-DESC', amount: 2000 },
      row: { keyClaimSealed: 'S3CRETO-SELLADA', keyHint: 'oxp_live_…a1b2' },
    });
    const text = lines.join('');
    expect(text).not.toMatch(/S3CRETO-QR|04A1B2C3D4E5F6|S3CRETO-DESC|S3CRETO-SELLADA/);
    expect(withoutRunInfo(lines)[0]).toMatchObject({ body: { amount: 2000 }, row: { keyHint: 'oxp_live_…a1b2' } });
  });
});
