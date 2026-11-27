// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nfcHub, readCard } from '@/lib/nfc';
import { SERVICIO_SCAN_TEXTS } from '@/lib/servicio';
import type { CobrarContext } from '@/components/cobrar/cobrar-context';
import { EscanearChica } from '@/components/cobrar/EscanearChica';

// La ficha de la compañera en «Cobrar su servicio»: Chrome solo deja empezar
// a leer NFC dentro de un toque. Sin el permiso dado, la lectura no arranca
// sola (fallaría y la ficha no se podría usar): «Leer su ficha» la arranca en
// la misma pulsación y, si se rechaza, se puede volver a intentar. Con el
// permiso ya dado, arranca sola.

vi.mock('@/lib/nfc', () => ({ nfcSupported: () => true, nfcHub: vi.fn(), readCard: vi.fn() }));
vi.mock('@/lib/api-cobro', () => ({ resolveStaffCard: vi.fn(), resolveStaffQr: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = { post: null, user: { role: 'MANAGER' }, sections: [] } as unknown as CobrarContext;
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

let host: HTMLDivElement;
let root: Root;
function mount(granted: boolean) {
  vi.mocked(nfcHub).mockReturnValue({ startIfAllowed: vi.fn(() => Promise.resolve(granted)) } as never);
  act(() =>
    root.render(
      <EscanearChica ctx={ctx} who="Nerea" title="Servicio" priceCents={5000} onChica={async () => true} onBack={() => undefined} texts={SERVICIO_SCAN_TEXTS} />,
    ),
  );
}
const leer = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Leer su ficha');

beforeEach(() => {
  vi.mocked(readCard).mockReset();
  vi.mocked(readCard).mockImplementation((signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))));
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('«Leer su ficha»: la lectura NFC arranca en el toque', () => {
  it('sin permiso, no lee sola: el botón la arranca dentro de la pulsación', async () => {
    mount(false);
    await flush();
    expect(readCard).not.toHaveBeenCalled();
    const btn = leer()!;
    expect(btn).toBeDefined();
    act(() => btn.click());
    expect(readCard).toHaveBeenCalledTimes(1);
    expect(leer()).toBeUndefined();
  });

  it('si se rechaza, lo dice y se puede volver a intentar', async () => {
    vi.mocked(readCard).mockRejectedValueOnce(new DOMException('NFC permission request denied.', 'NotAllowedError'));
    mount(false);
    await flush();
    act(() => leer()!.click());
    await flush();
    expect(host.textContent).toContain('NFC permission request denied.');
    act(() => leer()!.click());
    expect(readCard).toHaveBeenCalledTimes(2);
  });

  it('con el permiso ya dado, lee sola y no enseña el botón', async () => {
    mount(true);
    await flush();
    expect(readCard).toHaveBeenCalledTimes(1);
    expect(leer()).toBeUndefined();
  });
});
