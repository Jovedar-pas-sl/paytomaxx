import { describe, expect, it } from 'vitest';
import * as webpush from 'web-push';
import { readWebPushConfig, webPushWarning } from '../../../config/web-push';
import { parsePushSubscription, pushEndpoint } from './push-subscription';

const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 1).toString('base64url');

describe('suscripción del navegador', () => {
  it('acepta los servicios de avisos de los navegadores', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://web.push.apple.com/QK7x',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-db5p.notify.windows.com/w/?token=BQYAAA',
    ]) {
      expect(parsePushSubscription({ endpoint, keys: { p256dh: P256DH, auth: AUTH } })).toEqual({ endpoint: new URL(endpoint).toString(), p256dh: P256DH, auth: AUTH });
    }
  });

  it('no deja que el servidor llame a otra dirección (http, otro dominio, puerto, usuario)', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://evil.example.com/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://localhost/x',
      'https://10.0.0.1/x',
      `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
    ]) {
      expect(pushEndpoint(endpoint)).toBeNull();
    }
  });

  it('las claves tienen que ser las de un navegador (65 y 16 bytes)', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/x';
    expect(parsePushSubscription({ endpoint, keys: { p256dh: AUTH, auth: AUTH } })).toBeNull();
    expect(parsePushSubscription({ endpoint, keys: { p256dh: P256DH, auth: P256DH } })).toBeNull();
    expect(parsePushSubscription({ endpoint, keys: { p256dh: Buffer.alloc(65, 5).toString('base64url'), auth: AUTH } })).toBeNull();
    expect(parsePushSubscription({ endpoint, keys: { p256dh: `${P256DH}<`, auth: AUTH } })).toBeNull();
    expect(parsePushSubscription({ endpoint })).toBeNull();
    expect(parsePushSubscription(null)).toBeNull();
    // Con relleno (=) también vale; se guarda sin él.
    expect(parsePushSubscription({ endpoint, keys: { p256dh: P256DH, auth: `${AUTH}==` } })?.auth).toBe(AUTH);
  });
});

describe('claves VAPID (variables de entorno)', () => {
  const keys = webpush.generateVAPIDKeys();

  it('sin ninguna, apagado y sin aviso', () => {
    expect(readWebPushConfig({})).toEqual({ status: 'off' });
    expect(webPushWarning({})).toBeNull();
  });

  it('las tres bien: encendido', () => {
    const env = { WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: 'mailto:soporte@ejemplo.es' };
    expect(readWebPushConfig(env)).toMatchObject({ status: 'on', settings: { publicKey: keys.publicKey, subject: 'mailto:soporte@ejemplo.es' } });
    expect(readWebPushConfig({ ...env, WEB_PUSH_SUBJECT: 'https://ejemplo.es' }).status).toBe('on');
  });

  it('a medias o mal escritas: apagado, y el aviso dice qué falla sin enseñar el valor', () => {
    const half = webPushWarning({ WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey });
    expect(half).toMatch(/WEB_PUSH_VAPID_PRIVATE_KEY/);
    expect(half).not.toContain(keys.publicKey);
    const swapped = { WEB_PUSH_VAPID_PUBLIC_KEY: keys.privateKey, WEB_PUSH_VAPID_PRIVATE_KEY: keys.publicKey, WEB_PUSH_SUBJECT: 'http://x.es' };
    expect(readWebPushConfig(swapped).status).toBe('invalid');
    const warning = webPushWarning(swapped) ?? '';
    expect(warning).toMatch(/PUBLIC_KEY/);
    expect(warning).toMatch(/PRIVATE_KEY/);
    expect(warning).toMatch(/SUBJECT/);
    expect(warning).not.toContain(keys.privateKey);
  });
});
