import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { waitingListensNfc } from './nfc';

// APP-03: Inicio y Saldo siguen montados (con `hidden`) al cambiar de pestaña.
// Una pantalla escondida no escucha el NFC: la ficha que se acerca en
// Recepción no puede pagar el cobro que quedó abierto en Inicio.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('el NFC de «Esperando», solo a la vista', () => {
  const base = { nfcOn: true, waiting: true, pinOpen: false, checking: false, shown: true };

  it('esperando y a la vista: escucha', () => {
    expect(waitingListensNfc(base)).toBe(true);
  });

  it('con su pestaña oculta no escucha (aunque el cobro siga abierto)', () => {
    expect(waitingListensNfc({ ...base, shown: false })).toBe(false);
  });

  it('tampoco sin NFC, ya resuelto, con el PIN delante o comprobando un pago sin respuesta', () => {
    expect(waitingListensNfc({ ...base, nfcOn: false })).toBe(false);
    expect(waitingListensNfc({ ...base, waiting: false })).toBe(false);
    expect(waitingListensNfc({ ...base, pinOpen: true })).toBe(false);
    expect(waitingListensNfc({ ...base, checking: true })).toBe(false);
  });
});

describe('las pantallas lo usan (como la recepción, con useShown)', () => {
  it('Esperando mira si se ve y lo exige para leer', () => {
    const src = read('../components/cobrar/Esperando.tsx');
    expect(src).toMatch(/useShown\(\)/);
    expect(src).toMatch(/waitingListensNfc\(\{[^}]*shown[^}]*\}\)/);
  });

  it('el lector de «Cobrar del saldo» se corta al ocultar su pestaña', () => {
    const src = read('../components/ChargeFromBalance.tsx');
    expect(src).toMatch(/useShown\(\)/);
    expect(src).toMatch(/if \(!shown\) reading\?\.abort\(\)/);
  });
});
