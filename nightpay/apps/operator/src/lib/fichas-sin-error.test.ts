import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Estudio de fichas, capa A: lo que no es lógica pura sino cómo se cablea en
 * las pantallas (sin cambiar ningún paso).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('un saldo sin ficha encontrado por su código: «Darle una» (A7)', () => {
  const desk = read('../components/reception/desk/ReceptionDesk.tsx');
  const tab = read('../components/reception/ReceptionTab.tsx');
  const give = read('../components/reception/GiveFicha.tsx');

  it('solo en la entrada, a un saldo sin ficha y sin bloquear', () => {
    const fn = desk.slice(desk.indexOf('function giveFichaOf('), desk.indexOf('function onCode('));
    expect(fn).toContain("mode !== 'entrada'");
    expect(fn).toContain("view?.kind !== 'saldo'");
    expect(fn).toContain('view.fichaNumber !== null');
    expect(fn).toContain('view.blocked');
  });

  it('lleva a «Dar ficha a un saldo» con su código ya escrito, y se busca como siempre (con su QR o su PIN)', () => {
    expect(tab).toMatch(/initialCode=\{fichaCode\}/);
    expect(tab).toMatch(/const giveFicha = methods\.nfc/);
    expect(give).toContain("useState(initialCode ?? '')");
    // Nada se busca solo: el paso de buscar sigue igual.
    expect(give).not.toMatch(/useEffect\([^)]*find\(/);
  });
});

describe('B1: por encima del tope sin PIN, el teclado sale solo al cargar, con «Ahora no»', () => {
  const desk = read('../components/reception/desk/ReceptionDesk.tsx');
  const pad = read('../components/PinPad.tsx');

  it('CARGADO con el PIN pendiente abre el teclado sin tocar nada (una vez: al volver, ya no)', () => {
    const loaded = desk.slice(desk.indexOf('function renderLoaded('), desk.indexOf('function renderPinFirst('));
    expect(loaded).toMatch(/if \(pin === 'ask' && done\.wallet && !done\.seen && !done\.pinSkipped\) \{\s*return renderPinFirst\(/);
  });

  it('«Ahora no» vuelve a CARGADO sin sonar otra vez; con el PIN puesto, también', () => {
    const first = desk.slice(desk.indexOf('function renderPinFirst('), desk.indexOf('function renderMethod('));
    expect(first).toContain('cancelLabel="Ahora no"');
    expect(first).toContain("go({ kind: 'loaded', done: { ...done, seen: true, pinSkipped: true } })");
    expect(first).toContain("go({ kind: 'loaded', done: { ...done, wallet: next, seen: true } })");
    // Tras «Ahora no», el botón grande es «Siguiente cliente» y el PIN queda a mano.
    expect(desk).toContain("primary={pin === 'ask' && !done.pinSkipped ? askPin : next}");
  });

  it('el teclado de siempre, con su tecla de salir con otro nombre', () => {
    expect(pad).toContain("cancelLabel = 'Cancelar'");
    expect(pad).toMatch(/onClick=\{onCancel\} disabled=\{busy\}>\s*\{cancelLabel\}/);
  });
});

describe('B5: «Escanear su QR (cargó en casa)» en la primera pantalla y la ficha nueva se lee sola', () => {
  const desk = read('../components/reception/desk/ReceptionDesk.tsx');
  const tab = read('../components/reception/ReceptionTab.tsx');
  const give = read('../components/reception/GiveFicha.tsx');

  it('una fila más en la primera pantalla de la entrada, que abre la cámara de «Dar ficha a un saldo»', () => {
    expect(desk).toContain('<DeskRowLink label="Escanear su QR (cargó en casa)" onClick={onScanHome} />');
    expect(desk).toContain("onScanHome && mode === 'entrada'");
    expect(tab).toMatch(/methods\.nfc && qrScanSupported\(\)/);
    expect(tab).toContain('scanFirst={scanFirst}');
    expect(give).toContain("scanFirst && qrScanSupported() ? { kind: 'scan' } : { kind: 'find' }");
  });

  it('con su saldo encontrado, la ficha se lee sin tocar «Acercar la ficha» (una vez; si falla, queda el botón)', () => {
    expect(give).toMatch(/if \(step\.kind !== 'tap' \|\| !reader\.via \|\| busy \|\| reading \|\| autoRead\.current === step\.found\) return;\s*autoRead\.current = step\.found;\s*void tapAndGive\(step\.found\);/);
    // Las pruebas de que es suyo, las de siempre: su QR, o su código y su PIN (el encargado, ninguna).
    expect(give).toContain('if (proof || manager) return setStep({ kind: \'tap\', found });');
  });
});

describe('auditoría gráfica en recepción: como el resto de la app', () => {
  it('«Cargado» y «Devuelto», como «Pagado» (sin mayúsculas)', () => {
    const desk = read('../components/reception/desk/ReceptionDesk.tsx');
    const existing = read('../components/reception/TopUpExisting.tsx');
    expect(desk).toContain('word="Cargado"');
    expect(desk).toContain('word="Devuelto"');
    expect(existing).toContain('word="Cargado"');
    expect(`${desk}${existing}`).not.toMatch(/word="(CARGADO|DEVUELTO)"/);
  });

  it('la cabecera de recepción, como ScreenHeader: el mismo logo y «Atrás»', () => {
    const parts = read('../components/reception/desk/desk-parts.tsx');
    const screen = read('../components/cobrar/ScreenHeader.tsx');
    const logo = (src: string) => src.match(/<Logo variant="symbol" height="([^"]+)"/)?.[1];
    expect(logo(parts)).toBe(logo(screen));
    expect(parts).toContain('aria-label="Atrás"');
    expect(screen).toContain('aria-label="Atrás"');
  });
});

describe('B11: preparar fichas sin teclear', () => {
  it('al pedir el número impreso, propone el siguiente a la anterior; el aviso de A12 sigue si se cambia', () => {
    const prep = read('../components/reception/PrepareFichas.tsx');
    expect(prep).toContain("setPrintedNumber(nextPrintedNumber(lastPrintedRef.current) ?? '');");
    expect(prep).toContain('notFollowingText(lastPrinted, printedNumber)');
  });
});
