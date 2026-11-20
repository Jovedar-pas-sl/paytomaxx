import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PAYOUT_SW_URL, pushSupport, sameKey, vapidKeyBytes } from './payout-push';

// «Avisarme cuando me paguen»: qué puede cada móvil, la clave del servidor tal
// como la pide el navegador y el service worker que enseña el aviso.

describe('pushSupport', () => {
  const full = { serviceWorker: true, pushManager: true, notification: true, ios: false, standalone: false };

  it('con service worker, avisos y notificaciones: se puede', () => {
    expect(pushSupport(full)).toBe('ok');
    expect(pushSupport({ ...full, ios: true, standalone: true })).toBe('ok');
  });

  it('en el iPhone sin abrirla desde la pantalla de inicio: hay que añadirla primero', () => {
    expect(pushSupport({ ...full, pushManager: false, notification: false, ios: true, standalone: false })).toBe('install');
  });

  it('en un navegador sin avisos: no se puede', () => {
    expect(pushSupport({ ...full, pushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...full, serviceWorker: false, ios: true, standalone: true })).toBe('unsupported');
  });
});

describe('la clave del servidor', () => {
  const key = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]);

  it('de base64url a bytes, como la pide pushManager.subscribe', () => {
    expect(Buffer.from(vapidKeyBytes(key.toString('base64url')))).toEqual(key);
  });

  it('la suscripción es con esta clave o con otra (el dueño la cambió: hay que volver a apuntarse)', () => {
    const bytes = vapidKeyBytes(key.toString('base64url'));
    expect(sameKey(new Uint8Array(key).buffer, bytes)).toBe(true);
    expect(sameKey(new Uint8Array(Buffer.alloc(65, 1)).buffer, bytes)).toBe(false);
    expect(sameKey(null, bytes)).toBe(false);
  });
});

describe('el service worker del aviso', () => {
  const code = readFileSync(new URL(`../../public${PAYOUT_SW_URL}`, import.meta.url), 'utf8');

  function load() {
    const listeners: Record<string, (e: unknown) => void> = {};
    const showNotification = vi.fn(async () => undefined);
    const openWindow = vi.fn(async (_url: string) => undefined);
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn;
      },
      skipWaiting: vi.fn(),
      registration: { showNotification },
      clients: { claim: vi.fn(), openWindow },
    };
    new Function('self', code)(self);
    const fire = (type: string, event: Record<string, unknown>) => {
      const waits: unknown[] = [];
      listeners[type]!({ ...event, waitUntil: (p: unknown) => waits.push(p) });
      return waits;
    };
    return { fire, showNotification, openWindow };
  }

  it('enseña el aviso con su título, su texto y su etiqueta', () => {
    const sw = load();
    const payload = { title: 'Te han pagado 37,50 €', body: 'Míralo en Ganancias.', tag: 'pago-1', url: '/?t=ganancias' };
    sw.fire('push', { data: { json: () => payload } });
    expect(sw.showNotification).toHaveBeenCalledWith('Te han pagado 37,50 €', expect.objectContaining({ body: 'Míralo en Ganancias.', tag: 'pago-1', data: { url: '/?t=ganancias' } }));
  });

  it('al tocarlo abre una página de la app, nunca otro sitio', () => {
    const sw = load();
    const click = (url: unknown) => sw.fire('notificationclick', { notification: { close: vi.fn(), data: { url } } });
    click('/?t=ganancias');
    click('https://otro.example/');
    click('//otro.example/');
    click(`/${String.fromCharCode(92)}otro.example/`);
    click(undefined);
    expect(sw.openWindow.mock.calls.map((c) => c[0])).toEqual(['/?t=ganancias', '/', '/', '/', '/']);
  });
});
