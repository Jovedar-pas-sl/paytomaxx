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

describe('logger HTTP (pino de Fastify)', () => {
  it('tapa cabeceras de sesión, el secreto de Cloudflare y campos sensibles', () => {
    const { lines, stream } = capture();
    const { serializers: _serializers, ...options } = httpLoggerOptions('info');
    const log = pino(options, stream);
    log.info(
      {
        req: { headers: { authorization: 'Bearer jwt', cookie: 'sid=1', 'x-origin-auth': 'sec', accept: 'json' } },
        body: { pin: '1234', pin2: '1234', password: 'pw', secret: 's', tokenizationData: 't', amount: 5 },
        redsys: { Ds_MerchantParameters: 'eyJ', Ds_Signature: 'sig' },
      },
      'petición',
    );
    const out = lines.join('');
    expect(out).not.toMatch(/jwt|sid=1|"sec"|1234|"pw"|"eyJ"|"sig"|"t"/);
    expect(out).toContain('"accept":"json"');
    expect(out).toContain('"amount":5');
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
