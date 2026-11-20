// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayoutProfile } from '@/components/PayoutProfile';
import { forgetPushHere } from './payout-push';

// «Avisarme cuando me paguen» cuando el API no guarda el aviso (sin cobertura,
// un 5xx, el modo práctica…): el navegador ya se había suscrito.
const phone = vi.hoisted(() => ({ subscribed: false }));
vi.mock('./api', () => ({ fetchMyPayoutInfo: vi.fn(async () => ({ account: null })) }));
vi.mock('./payout-push', () => ({
  fetchPushKey: vi.fn(async () => 'clave-publica'),
  pushHere: vi.fn(async () => (phone.subscribed ? 'on' : 'off')),
  turnPushOn: vi.fn(async () => {
    phone.subscribed = true;
    throw new Error('El aviso: no se ha podido guardar.');
  }),
  turnPushOff: vi.fn(),
  forgetPushHere: vi.fn(async () => {
    phone.subscribed = false;
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('«Avisarme cuando me paguen» si el API no lo guarda', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    phone.subscribed = false;
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  /** Hace algo y deja terminar lo que viene detrás (la clave, el móvil, el API). */
  const settle = (fn: () => void) =>
    act(async () => {
      fn();
      await new Promise((r) => setTimeout(r, 0));
    });
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  it('lo dice y el móvil queda apagado, sin suscripción, con el botón para volver a probar', async () => {
    await settle(() => root.render(<PayoutProfile />));
    await settle(() => button('Avisarme cuando me paguen')!.click());

    expect(host.textContent).toContain('El aviso: no se ha podido guardar.');
    expect(host.textContent).toContain('Recibe un aviso en este móvil cuando te paguen.');
    expect(host.textContent).not.toContain('Te avisamos');
    expect(button('Avisarme cuando me paguen')).toBeDefined();
    expect(forgetPushHere).toHaveBeenCalledOnce();
    expect(phone.subscribed).toBe(false);
  });
});
