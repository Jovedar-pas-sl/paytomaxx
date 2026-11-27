// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { issueStaffCard, reserveStaffCardCode } from '@/lib/api';
import { StaffCardBox } from './StaffCardBox';

// Darle su ficha en dos toques: el primero pide el código al servidor; el
// segundo («Grabar») arranca el lector NFC dentro del mismo toque. Si se
// esperase al servidor antes de leer, Chrome perdería el toque
// (NotAllowedError) con red lenta y la primera ficha no se podría dar.

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  reserveStaffCardCode: vi.fn(),
  issueStaffCard: vi.fn(),
  revokeStaffCard: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scan = vi.fn();
let lastReader: { onreading: ((e: unknown) => void) | null } | null = null;
class FakeReader {
  onreading: ((e: unknown) => void) | null = null;
  onreadingerror: ((e: unknown) => void) | null = null;
  constructor() {
    lastReader = this;
  }
  scan(options?: { signal?: AbortSignal }) {
    scan(options);
    return Promise.resolve();
  }
  write = vi.fn(() => Promise.resolve());
}

describe('«Darle su ficha»: el código antes, el lector en el toque de «Grabar»', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('NDEFReader', FakeReader);
    scan.mockReset();
    lastReader = null;
    vi.mocked(reserveStaffCardCode).mockReset();
    vi.mocked(issueStaffCard).mockReset();
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);

  it('el primer toque solo pide el código; «Grabar» arranca el lector sin esperar a nada', async () => {
    let resolveCode!: (code: string) => void;
    vi.mocked(reserveStaffCardCode).mockReturnValue(new Promise((r) => (resolveCode = r)));
    vi.mocked(issueStaffCard).mockResolvedValue({ number: 522 } as never);
    act(() => root.render(<StaffCardBox operatorId="op-1" name="Ana" initial={null} onChanged={() => undefined} />));

    act(() => button('Darle su ficha')!.click());
    expect(reserveStaffCardCode).toHaveBeenCalledWith('op-1');
    expect(scan).not.toHaveBeenCalled();
    expect(button('Grabar')).toBeUndefined();

    await act(async () => resolveCode('CODIGO123'));
    expect(document.body.textContent).toContain('Acerca la ficha en blanco y pulsa «Grabar».');
    expect(scan).not.toHaveBeenCalled();

    // Dentro del mismo toque, antes de cualquier espera.
    act(() => button('Grabar')!.click());
    expect(scan).toHaveBeenCalledTimes(1);
    expect(reserveStaffCardCode).toHaveBeenCalledTimes(1);

    await act(async () => lastReader!.onreading!({ serialNumber: '04:a1:b2:c3:d4:e5:f6', message: { records: [{ recordType: 'empty' }] } }));
    expect(issueStaffCard).toHaveBeenCalledWith('op-1', expect.objectContaining({ card: 'CODIGO123' }));
    expect(document.body.textContent).toContain('Ficha nº 0522 dada a Ana.');
  });

  it('si el servidor no da el código, se dice y no se arranca el lector', async () => {
    vi.mocked(reserveStaffCardCode).mockRejectedValue(new Error('Sin conexión.'));
    act(() => root.render(<StaffCardBox operatorId="op-1" name="Ana" initial={null} onChanged={() => undefined} />));
    await act(async () => button('Darle su ficha')!.click());
    expect(document.body.textContent).toContain('Sin conexión.');
    expect(button('Grabar')).toBeUndefined();
    expect(scan).not.toHaveBeenCalled();
  });
});
