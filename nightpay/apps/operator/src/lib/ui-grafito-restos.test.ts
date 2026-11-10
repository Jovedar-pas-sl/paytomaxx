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
      const text = code(read(rel));
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

  it('más junta que los otros resultados: huecos de 8 y la marca y el importe de 56', () => {
    expect(block('.body')).toContain('gap: 0.5rem');
    expect(loaded).toMatch(/\.body :global\(\.np-outcome-ring\) \{\s*width: 3\.5rem;\s*height: 3\.5rem;/);
    expect(loaded).toMatch(/\.body :global\(\.np-outcome-amount\) \{\s*font-size: min\(3\.5rem,/);
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
