// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaxScreen } from '@/components/pax/PaxScreen';

// El datáfono pasa de «sin vincular» a vinculado (al vincularlo o al recargar con
// la credencial guardada): la pantalla salía «Esta pantalla ha fallado» (un hook
// después de los return tempranos cambiaba el número de hooks entre renders).
const TERMINAL = { terminal: { label: 'Barra 1', zone: null }, venueName: 'Local de prueba' };
const API: Record<string, unknown> = {
  '/v1/pos-device/pair': { ...TERMINAL, token: 'tok' },
  '/v1/pos-device/me': TERMINAL,
  '/v1/pos-device/pending': [],
  '/v1/pos-device/reception/options': { card: true, cash: true, cashBlockedReason: null, nfc: true },
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Datáfono: al quedar vinculado se ve la pantalla de cobro', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(API[new URL(url).pathname])));
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  /** Hace algo y deja terminar lo que viene detrás (el API de mentira). */
  const settle = (fn: () => void) =>
    act(async () => {
      fn();
      await new Promise((r) => setTimeout(r, 0));
    });
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  it('nada más vincularlo: cobrar, saldo y fichas', async () => {
    await settle(() => root.render(<PaxScreen />));
    await settle(() => button('Vincular')!.click());

    expect(host.textContent).toContain('Cobrar con saldo');
    expect(host.textContent).toContain('Recepción: recargar saldo');
    expect(host.textContent).toContain('Preparar fichas');
    expect(host.textContent).toContain('No hay cobros esperando.');
  });

  it('al recargar ya vinculado: lo mismo', async () => {
    localStorage.setItem('np_pax_device_token', 'tok');
    await settle(() => root.render(<PaxScreen />));

    expect(host.textContent).toContain('Cobrar con saldo');
    expect(host.textContent).toContain('No hay cobros esperando.');
  });
});
