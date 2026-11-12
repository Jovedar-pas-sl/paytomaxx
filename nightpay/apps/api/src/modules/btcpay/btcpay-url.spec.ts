import { describe, it, expect } from 'vitest';
import { isForbiddenIp, parseBtcpayUrl } from './btcpay-url';

describe('parseBtcpayUrl: la URL que escribe el dueño', () => {
  it('acepta https://dominio y la deja en su origen', () => {
    const r = parseBtcpayUrl('  https://Pay.Sala-Bambu.es/  ');
    expect(r).toEqual({ ok: true, origin: 'https://pay.sala-bambu.es', host: 'pay.sala-bambu.es' });
  });

  it('acepta el puerto 443 escrito', () => {
    expect(parseBtcpayUrl('https://pay.sala-bambu.es:443')).toMatchObject({ ok: true, origin: 'https://pay.sala-bambu.es' });
  });

  it.each([
    ['http://pay.sala-bambu.es', 'NOT_HTTPS'],
    ['ftp://pay.sala-bambu.es', 'NOT_HTTPS'],
    ['pay.sala-bambu.es', 'INVALID'],
    ['', 'INVALID'],
    ['https://', 'INVALID'],
    ['https://pay.sala-bambu.es:8443', 'BAD_PORT'],
    ['https://pay.sala-bambu.es:80', 'BAD_PORT'],
    ['https://usuario@pay.sala-bambu.es', 'CREDENTIALS'],
    ['https://usuario:clave@pay.sala-bambu.es', 'CREDENTIALS'],
    ['https://:clave@pay.sala-bambu.es', 'CREDENTIALS'],
    ['https://pay.sala-bambu.es/btcpay', 'HAS_PATH'],
    ['https://pay.sala-bambu.es/?x=1', 'HAS_PATH'],
    ['https://pay.sala-bambu.es/#x', 'HAS_PATH'],
  ])('rechaza %s', (raw, code) => {
    expect(parseBtcpayUrl(raw)).toMatchObject({ ok: false, code });
  });

  it.each([
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://169.254.169.254',
    'https://8.8.8.8',
    'https://[::1]',
    'https://[2001:4860:4860::8888]',
    // formas raras que se normalizan a una IP
    'https://2130706433',
    'https://0x7f.0.0.1',
    'https://0177.0.0.1',
    'https://127.1',
  ])('rechaza la IP literal %s', (raw) => {
    expect(parseBtcpayUrl(raw)).toMatchObject({ ok: false, code: 'IP_LITERAL' });
  });

  it.each(['https://localhost', 'https://intranet', 'https://caja.local', 'https://x.internal', 'https://a.localhost'])(
    'rechaza el nombre local %s',
    (raw) => {
      expect(parseBtcpayUrl(raw)).toMatchObject({ ok: false, code: 'LOCAL_NAME' });
    },
  );

  it('rechaza lo que no es texto o es larguísimo', () => {
    expect(parseBtcpayUrl(undefined)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(parseBtcpayUrl(`https://${'a'.repeat(3000)}.es`)).toMatchObject({ ok: false, code: 'INVALID' });
  });
});

describe('isForbiddenIp: direcciones a las que el servidor no llama', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.0.9',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fe80::abcd%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a00:1',
    '2001:db8::1', '2002:7f00:1::1', '100::1', '::8.8.8.8', '::808:808', '64:ff9b:1::1', '64:ff9b:1:ffff::8.8.8.8',
    'no es una ip', '', '999.1.1.1', '1.2.3',
  ])('prohíbe %s', (ip) => {
    expect(isForbiddenIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4007::200e', '::ffff:8.8.8.8'])(
    'permite la pública %s',
    (ip) => {
      expect(isForbiddenIp(ip)).toBe(false);
    },
  );
});
