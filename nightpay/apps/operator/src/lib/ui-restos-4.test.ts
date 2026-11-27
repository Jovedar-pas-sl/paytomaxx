import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Entrega 4, parte B — los restos de las entregas 2 y 3 en la app del
// personal, sin cambiar reglas ni textos: el dinero con Importe, las líneas
// rojas a mano en FieldError / FormError y los botones del pie de las hojas
// en el `footer` de Sheet.

const SRC = fileURLToPath(new URL('..', import.meta.url));
const COMPONENTS = join(SRC, 'components');
const read = (rel: string): string => readFileSync(join(COMPONENTS, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('Importe en el resto de la app (fuera de cobrar, recepción, pax, pantalla, party y Ganancias)', () => {
  it('lo cobrado de cada pago recibido, con su estilo', () => {
    const src = read('PayoutsReceived.tsx');
    expect(src).toContain('<Importe cents={p.totalCents} className="np-num" style={amountStyle} />');
    expect(src).not.toContain('formatEur(p.totalCents');
  });

  it('las cifras de las reservas del RRPP, con todos sus céntimos como hoy', () => {
    const src = read('rrpp/RrppView.tsx');
    expect(src).toContain('<dd className="np-num">\n        <Importe cents={cents} decimals="always" />');
    for (const field of ['priceCents', 'paidCents', 'pendingCents'])
      expect(src).toContain(`<b className="np-num">\n            <Importe cents={r.${field}} decimals="always" />`);
    expect(src).not.toMatch(/formatEur\(/);
  });

  it('el total del detalle del cobro, con su clase', () => {
    const src = read('CobroDetailSheet.tsx');
    expect(src).toContain('<b className={`np-num ${styles.total}`}>\n          <Importe cents={d.totalCents} decimals="always" />');
    expect(src).not.toContain('eur(d.totalCents)}</b>');
  });
});

describe('ninguna línea roja a mano (eran 21)', () => {
  /** Fuera de cobrar/, pax/, reception/desk/, accept-invite y onboarding (entregas 6, 7 y 8). */
  const OUT = /^(components\/(cobrar|pax|reception\/desk)\/|app\/(accept-invite|onboarding)\/)/;
  /** Lo rojo que no es una línea de error: «Salir» (un botón) y el resultado de un cobro con ficha (Cobrar, entrega 7). */
  const NOT_ERRORS = ['components/FichaTapped.tsx', 'components/PassScanned.tsx', 'components/staff-menu.tsx'];

  const files = [...sources(COMPONENTS), ...sources(join(SRC, 'app'))]
    .map((path) => ({ rel: relative(SRC, path).replace(/\\/g, '/'), text: strip(readFileSync(path, 'utf8')) }))
    .filter((f) => !OUT.test(f.rel));

  it("ningún color: … 'var(--np-danger…' salvo lo que no es un error", () => {
    const left = files.filter((f) => /color: [^,;}]*'var\(--np-danger/.test(f.text)).map((f) => f.rel);
    expect(left.sort()).toEqual(NOT_ERRORS);
  });

  it('en EarningsDetail, lo rojo es solo el tono «danger» de la etiqueta', () => {
    const src = strip(read('EarningsDetail.tsx'));
    expect(src.match(/'var\(--np-danger[a-z-]*\)'/g)).toEqual(["'var(--np-danger)'"]);
    expect(src).toContain("danger: 'var(--np-danger)',");
  });

  it('ni constantes de estilo de error (errorStyle, err, bad)', () => {
    const left = files.filter((f) => /const (errorStyle|err|bad): CSSProperties/.test(f.text)).map((f) => f.rel);
    expect(left).toEqual([]);
  });

  it('lo que falla al hacer algo, en FormError', () => {
    const count: Array<[string, number]> = [
      ['ActivePayment.tsx', 1],
      ['CobroDetailSheet.tsx', 2],
      ['CustomerDisplaySheet.tsx', 1],
      ['DeviceSheet.tsx', 2],
      ['EarningsDetail.tsx', 2],
      ['NewWalletCard.tsx', 2],
      ['OxiocardCard.tsx', 1],
      ['PasskeySheet.tsx', 1],
      ['PendingPos.tsx', 2],
      ['PinPad.tsx', 1],
      ['StepUpSheet.tsx', 1],
      ['UnpaidInVenue.tsx', 1],
      ['reservas/ReservasTab.tsx', 3],
    ];
    for (const [file, n] of count) expect(read(file).match(/<FormError>/g)?.length ?? 0, file).toBe(n);
  });

  it('«No es mío» (PR #68): su error, en FormError, sin tocar nada más del bloque', () => {
    const src = read('EarningsDetail.tsx');
    const notMine = src.slice(src.indexOf('function NotMine'));
    expect(notMine).toContain('{error ? <FormError>{error}</FormError> : null}');
    expect(notMine).toContain('Avisamos al encargado y al dueño. ¿Seguro?');
  });

  it('las fechas mal puestas, en FieldError debajo de los dos campos (los dos la apuntan)', () => {
    const src = read('DateRange.tsx');
    expect(src).toContain('<FieldError id={problemId}>{problem}</FieldError>');
    expect(src.match(/aria-describedby=\{problem \? problemId : undefined\}/g)).toHaveLength(2);
    expect(src).toContain('<p style={hintStyle}>Cada noche cuenta hasta las 8:00 del día siguiente.</p>');
  });
});

describe('los botones del pie de las hojas, en el `footer` de Sheet', () => {
  const SHEETS = ['CancelCobroConfirm.tsx', 'CobroDetailSheet.tsx', 'CustomerDisplaySheet.tsx', 'PasskeySheet.tsx', 'StepUpSheet.tsx', 'staff-menu.tsx'];

  for (const file of SHEETS) {
    it(file, () => {
      const src = read(file);
      expect(src).not.toContain('<Modal');
      expect(src).toMatch(/<Sheet\b[^>]*\bfooter=\{/);
    });
  }

  it('dos botones: los de la pregunta (np-pregunta-pie), el que hace la acción el último', () => {
    for (const file of ['CancelCobroConfirm.tsx', 'CustomerDisplaySheet.tsx']) expect(read(file), file).toContain('className="np-pregunta-pie"');
    const cancel = strip(read('CancelCobroConfirm.tsx'));
    expect(cancel.indexOf('Volver')).toBeLessThan(cancel.indexOf('Cancelar cobro'));
  });

  it('los formularios envían desde el pie con form=', () => {
    for (const file of ['PasskeySheet.tsx', 'StepUpSheet.tsx']) {
      const src = read(file);
      expect(src, file).toMatch(/<form id=\{formId\}/);
      expect(src, file).toMatch(/<Button type="submit" form=\{formId\}/);
    }
  });

  it('«Salir», en el pie del menú', () => {
    expect(read('staff-menu.tsx')).toContain('footer={<LogoutMenuItem onLogout={onLogout} />}');
  });

  it('«Este aparato» no tiene botones al pie: cada prueba lleva el suyo (sigue como Modal)', () => {
    expect(read('DeviceSheet.tsx')).toContain('<Modal open={open} onClose={onClose} title="Este aparato">');
  });
});
