import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Revisión de Grafito (9-nov-2026): las pantallas que quedaban con lo de
// antes (Cobros y Ganancias del personal, la ficha o el saldo leídos con el
// móvil, el aviso de invitación, CARGADO, el importe y el estado del TPV) ya
// no llevan mayúsculas, pesos 700/800, degradados, halos ni lima de adorno.
// Y CARGADO enseña sus dos botones sin bajar.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const FILES: Record<string, string> = {
  'my-cobros.module.css': '../components/my-cobros.module.css',
  'loaded.module.css': '../components/reception/desk/loaded.module.css',
  'guia.module.css': '../components/guia/guia.module.css',
  'TonightCard.tsx': '../components/TonightCard.tsx',
  'Earnings.tsx': '../components/Earnings.tsx',
  'EarningsDetail.tsx': '../components/EarningsDetail.tsx',
  'PayoutsReceived.tsx': '../components/PayoutsReceived.tsx',
  'FichaTapped.tsx': '../components/FichaTapped.tsx',
  'PassScanned.tsx': '../components/PassScanned.tsx',
  'InvitationToast.tsx': '../components/InvitationToast.tsx',
  'AmountDisplay.tsx': '../../../../packages/ui/src/components/AmountDisplay.tsx',
  'StatusPill.tsx': '../../../../packages/ui/src/components/StatusPill.tsx',
};

/** Sin los comentarios: lo que cuenta es el estilo, no lo que se explica. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('restos de antes de Grafito', () => {
  for (const [name, rel] of Object.entries(FILES)) {
    it(`${name}: sin mayúsculas, sin 700/800/900, sin degradados ni halos`, () => {
      // El 700 es solo de las cifras (Manrope, Grafito 3): se quita antes de mirar.
      const text = code(read(rel)).replace(/font:\s*700\s[^;]*--np-font-num[^;]*;/g, '');
      expect(text).not.toMatch(/text-transform:\s*uppercase|textTransform:\s*'uppercase'/);
      expect(text).not.toMatch(/font-weight:\s*[789]00|fontWeight:\s*'?[789]00|font:\s*[789]00/);
      expect(text).not.toMatch(/linear-gradient|radial-gradient|--np-lime-glow|blur\(/);
    });
  }

  it('la lima no va en totales, títulos ni avisos (solo en lo que se toca y el foco)', () => {
    for (const name of ['TonightCard.tsx', 'Earnings.tsx', 'EarningsDetail.tsx', 'FichaTapped.tsx', 'PassScanned.tsx', 'InvitationToast.tsx', 'my-cobros.module.css']) {
      expect(code(read(FILES[name]!)), name).not.toMatch(/--np-accent|--np-lime/);
    }
  });

  it('sin letras espaciadas, salvo en los códigos', () => {
    for (const name of ['my-cobros.module.css', 'loaded.module.css', 'TonightCard.tsx', 'Earnings.tsx', 'EarningsDetail.tsx', 'PayoutsReceived.tsx', 'PassScanned.tsx', 'InvitationToast.tsx', 'AmountDisplay.tsx', 'StatusPill.tsx']) {
      expect(code(read(FILES[name]!)), name).not.toMatch(/letter-spacing:\s*-?0\.\d|letterSpacing:\s*'-?0\.\d/);
    }
  });

  it('chips y estados con radio de chip (6), no de pastilla', () => {
    const cobros = code(read(FILES['my-cobros.module.css']!));
    const chip = cobros.slice(cobros.indexOf('.chip {'), cobros.indexOf('}', cobros.indexOf('.chip {')));
    expect(chip).toContain('border-radius: var(--np-r-xs)');
    expect(code(read(FILES['StatusPill.tsx']!))).toContain("borderRadius: 'var(--np-r-xs)'");
  });
});

// ─── CARGADO: los dos botones a la vista y el texto que se lea ─────────

const STYLES = read('../../../../packages/ui/src/styles.css');

function token(name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(STYLES);
  if (!m) throw new Error(`no está ${name}`);
  return m[1]!.toLowerCase();
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** color-mix(in srgb, fg p%, transparent) sobre bg: lo que se ve. */
const over = (fg: string, p: number, bg: string): [number, number, number] =>
  rgb(fg).map((c, i) => Math.round(c * p + rgb(bg)[i]! * (1 - p))) as [number, number, number];

describe('CARGADO (recepción)', () => {
  const loaded = code(read(FILES['loaded.module.css']!));
  const block = (sel: string) => loaded.slice(loaded.indexOf(`${sel} {`), loaded.indexOf('}', loaded.indexOf(`${sel} {`)));

  it('los botones, pegados abajo: se ven sin bajar aunque el QR de Face ID no quepa', () => {
    const foot = block('.resFoot');
    expect(foot).toContain('position: sticky');
    expect(foot).toContain('bottom: 0');
    expect(foot).toContain('background: var(--np-outcome-bg)');
  });

  it('más junta que los otros resultados: huecos de 8 y la marca de 56 y el importe de la escala (40)', () => {
    expect(block('.body')).toContain('gap: 0.5rem');
    expect(loaded).toMatch(/\.body :global\(\.np-outcome-ring\) \{\s*width: 3\.5rem;\s*height: 3\.5rem;/);
    expect(loaded).toMatch(/\.body :global\(\.np-outcome-amount\) \{\s*font-size: min\(var\(--np-fs-40\),/);
  });

  it('la línea de ayuda, en la crema del resultado (≥ 7:1 sobre el verde), no en el gris de las pantallas oscuras', () => {
    expect(block('.resHelp.resHelp')).toContain('color-mix(in srgb, var(--np-outcome-ink) 85%, transparent)');
    const seen = over(token('--np-outcome-ink'), 0.85, token('--np-outcome-paid'));
    expect(contrast(seen, rgb(token('--np-outcome-paid')))).toBeGreaterThanOrEqual(7);
  });

  it('la nota del PIN va en su línea con candado (ámbar ≥ 3:1 sobre el verde), no en la caja de lo que salió mal', () => {
    const desk = read('../components/reception/desk/ReceptionDesk.tsx');
    expect(desk).toContain('warn={done.warn}');
    expect(desk).toContain('note={pinText}');
    const card = read('../components/reception/desk/DeskLoaded.tsx');
    expect(card).toMatch(/<p className=\{s\.resNote\}>\s*<Icon name="lock" \/>/);
    expect(contrast(rgb('#f5b342'), rgb(token('--np-outcome-paid')))).toBeGreaterThanOrEqual(3);
    expect(token('--np-warning')).toBe('#f5b342');
  });
});

describe('textos del QR y de la invitación (revisión de Grafito 2)', () => {
  it('«10 min» del QR de Face ID no se parte en dos líneas (espacio duro)', () => {
    expect(read('../components/reception/desk/ActivationQr.tsx')).toContain('Vale una vez y 10&nbsp;min.');
  });

  it('invitación: «Tarjeta, QR o ficha, sin PIN» (no «Tarjeta o QR o NFC»)', () => {
    const src = read('../components/cobrar/Esperando.tsx');
    expect(src).toContain("invite ? (nfcOn ? 'Tarjeta, QR' : 'Tarjeta o QR') : 'Con tu móvil'");
    expect(src).toContain("invite ? (hasQr ? 'ficha, sin PIN' : 'Ficha, sin PIN') : nfcWayLabel(readerSpot)");
    expect(src).not.toContain("'NFC, sin PIN'");
  });
});

describe('CARGADO en un móvil bajo: el QR de Face ID y su línea, sin bajar (PS-A12)', () => {
  const css = read('../components/reception/desk/loaded.module.css');
  const block = (media: string) => css.slice(css.indexOf(media), css.indexOf('\n}\n', css.indexOf(media)));

  it('hasta 780 px de alto se juntan los huecos y el pie; hasta 700, la marca va en la fila de «CARGADO»', () => {
    expect(block('@media (max-height: 780px)')).toMatch(/gap: 0\.375rem/);
    expect(block('@media (max-height: 780px)')).toMatch(/\.resFoot :global\(\.np-outcome-actions\) \{\s*padding: 0\.375rem 0 0\.5rem;/);
    const low = block('@media (max-height: 700px)');
    expect(low).toMatch(/\.headline \{\s*display: flex;/);
    expect(low).toMatch(/width: 2\.5rem;\s*height: 2\.5rem;/);
    expect(css).toMatch(/\.headline \{\s*display: contents;/);
    expect(read('../components/reception/desk/DeskLoaded.tsx')).toMatch(/<div className=\{s\.headline\}>\s*<span className="np-outcome-ring"/);
  });

  it('los toques no bajan: ni el CSS de CARGADO toca la altura de los botones (56 y 48 px)', () => {
    expect(css).not.toMatch(/np-outcome-btn/);
    const staff = read('../../../../packages/ui/src/staff.css');
    expect(staff).toMatch(/\.np-outcome-btn \{\s*min-height: 3\.5rem;/);
    expect(staff).toMatch(/\.np-outcome-btn\[data-variant='secondary'\] \{\s*min-height: 3rem;/);
  });
});

describe('TPV en el móvil: el importe arriba, el QR debajo y «Cancelar cobro» siempre a la vista', () => {
  const css = read('../../../tpv/src/components/active-payment.module.css');
  const tsx = read('../../../tpv/src/components/ActivePayment.tsx');
  const phone = css.slice(css.indexOf('@media (max-width: 47.99rem)'));

  it('en una columna, la tarjeta del importe va primero y la de las acciones queda fija abajo', () => {
    expect(phone).toMatch(/\.amount \{\s*order: -1;\s*z-index: 1;/); // si no, la tarjeta del QR tapa la barra
    expect(phone).toMatch(/\.actions \{\s*position: fixed;[^}]*bottom: 0;/);
    // El hueco de abajo deja ver entera la tarjeta del QR por encima de la barra.
    expect(phone).toMatch(/\.grid \{[^}]*padding-bottom: calc\(5rem \+ env\(safe-area-inset-bottom\)\);/);
  });

  it('el cobro usa esas clases (en la tableta, como estaba: el QR y el importe en dos columnas)', () => {
    expect(tsx).toContain('<div className={styles.grid}>');
    expect(tsx).toContain('<Card className={styles.amount}');
    expect(tsx).toContain('<div className={styles.actions} data-tour="tpv-cancelar">');
    expect(css).toMatch(/\.grid \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 20rem\), 1fr\)\);/);
  });
});
