import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BusyWord, Button } from '../../../../packages/ui/src/components/Button';
import { HOLD_MS, HoldButton } from '../../../../packages/ui/src/components/HoldButton';
import { shakeClass } from '../../../../packages/ui/src/lib/shake';
import { cobrarLabel } from './carta-view';

// Grafito 3 · punto 9: más efectos (PIN, «Cobrando», mantener pulsado, selector).

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STAFF = read('../../../../packages/ui/src/staff.css');

describe('PIN', () => {
  it('el temblor dura 360 ms y alterna dos clases para repetirse', () => {
    expect(STAFF).toMatch(/\.np-shake-a,\s*\.np-shake-b \{\s*animation: np-shake 360ms ease-in-out 1;/);
    expect([0, 1, 2, 3].map(shakeClass)).toEqual(['', 'np-shake-a', 'np-shake-b', 'np-shake-a']);
  });

  it('PinScreen y PinPad tiemblan y vibran [30, 60, 30] al fallar', () => {
    for (const f of ['../components/cobrar/PinScreen.tsx', '../components/PinPad.tsx']) {
      const src = read(f);
      expect(src).toContain('pinFailed()');
      expect(src).toContain('shakeClass(shake)');
    }
    expect(read('../../../../packages/ui/src/lib/haptic.ts')).toContain('HAPTIC_BAD: readonly number[] = [30, 60, 30]');
  });

  it('los puntos se llenan con transición', () => {
    expect(read('../components/cobrar/cobrar.module.css')).toMatch(/\.dots i \{[^}]*transition: background/);
  });

  it('con «reducir movimiento» no tiembla ni suben los puntos', () => {
    expect(STAFF).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.np-shake-a,\s*\.np-shake-b,\s*\.np-dots > i \{\s*animation: none !important;/);
  });
});

describe('«Cobrar» mientras se crea el cobro', () => {
  it('pasa a «Cobrando» con tres puntos', () => {
    expect(cobrarLabel({ busy: true, empty: false, totalCents: 1000 })).toBe('Cobrando');
    const html = renderToStaticMarkup(<BusyWord word="Cobrando" />);
    expect(html).toContain('Cobrando');
    expect(html.match(/<i><\/i>/g)).toHaveLength(3);
  });

  it('Carta, La cuenta y Otro importe lo enseñan y los botones siguen deshabilitados', () => {
    for (const f of ['Carta', 'LaCuenta', 'OtroImporte']) {
      const src = read(`../components/cobrar/${f}.tsx`);
      expect(src).toContain('<BusyWord');
    }
    expect(read('../components/cobrar/Carta.tsx')).toContain('disabled={!canCharge}');
  });

  it('el botón del TPV: «Cobrando», deshabilitado y en su color', () => {
    const html = renderToStaticMarkup(
      <Button loading loadingLabel="Cobrando">
        Cobrar 5 €
      </Button>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('Cobrando');
    expect(html).not.toContain('Cobrar 5');
  });
});

describe('mantener pulsado 1,2 s', () => {
  it('son 1200 ms', () => {
    expect(HOLD_MS).toBe(1200);
    expect(STAFF).toMatch(/\.np-hold-fill\.on \{\s*width: 100%;\s*transition: width var\(--np-hold-ms, 1200ms\) linear;/);
  });

  it('el botón pinta su texto y no confirma al pintarse', () => {
    let done = 0;
    const html = renderToStaticMarkup(<HoldButton onConfirm={() => (done += 1)}>Mantén para cancelar el cobro</HoldButton>);
    expect(html).toContain('Mantén para cancelar el cobro');
    expect(done).toBe(0);
  });

  it('solo sustituye ventanas de «¿seguro?» sin dinero: cancelar con el banco y quitar el aviso', () => {
    const esperando = read('../components/cobrar/Esperando.tsx');
    expect(esperando).toContain('<HoldButton');
    expect(esperando).not.toContain('No, seguir esperando');
    expect(esperando).not.toContain('confirmingCancel');
    const ventas = read('../components/pax/SalesToReview.tsx');
    expect(ventas).toContain('<HoldButton');
    expect(ventas).not.toContain('setConfirming');
  });

  it('con «reducir movimiento» la barra no se anima', () => {
    expect(STAFF).toMatch(/\.np-hold-fill\.on \{\s*transition: none;\s*width: 0;/);
  });
});

describe('selector que se desliza', () => {
  it('Entrada / Salida: la marca crema se traslada con 220 ms', () => {
    const css = read('../components/reception/desk/desk.module.css');
    expect(css).toMatch(/\.seg::before \{[^}]*transition: transform 220ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
    expect(css).toContain(".seg[data-pos='1']::before");
    expect(read('../components/reception/desk/ReceptionDesk.tsx')).toContain("data-pos={mode === 'salida' ? 1 : 0}");
  });
});
