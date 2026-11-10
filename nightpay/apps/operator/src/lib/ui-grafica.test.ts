import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Auditoría gráfica (10-nov-2026): el punto de «esperando» no es verde, las
// zonas de toque del personal llegan a 44-48 px, el foco no deforma nada y
// Button no envía formularios sin querer.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const COBRAR = read('../components/cobrar/cobrar.module.css');
const STYLES = read('../../../../packages/ui/src/styles.css');
const block = (css: string, sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));

describe('auditoría gráfica', () => {
  it('esperando el pago, el punto que late es neutro: el verde es solo «pagado»', () => {
    expect(block(COBRAR, '.live i')).toContain('background: var(--np-text)');
    expect(block(COBRAR, '.live i')).not.toContain('--np-success');
  });

  it('«−», «+» y atrás, de 48 px', () => {
    for (const sel of ['.stepBtn', '.iconBtn']) {
      expect(block(COBRAR, sel)).toContain('width: 3rem');
      expect(block(COBRAR, sel)).toContain('height: 3rem');
    }
  });

  it('el botón pequeño, de 44 px en táctil y en el móvil', () => {
    expect(block(STYLES, ".np-touch .np-btn[data-size='sm']")).toContain('height: 2.75rem');
    expect(block(STYLES, "  .np-staff .np-btn[data-size='sm']")).toContain('height: 2.75rem');
  });

  it('el anillo del foco sin border-radius (seguía su propio radio y deformaba teclas)', () => {
    expect(block(STYLES, ':focus-visible')).not.toContain('border-radius');
  });

  it('Button es type="button" si no se dice otro', () => {
    expect(read('../../../../packages/ui/src/components/Button.tsx')).toMatch(/<button\s+type="button"\s+\{\.\.\.rest\}/);
  });

  it('«← Lista» de 44 px y la campana sin emoji', () => {
    const pos = read('../components/PendingPos.tsx');
    expect(block(pos.replace(/const backBtnStyle: CSSProperties =/, '.back'), '.back')).toContain("minHeight: '2.75rem'");
    expect(pos).not.toMatch(/🔔|🔕/u);
    expect(pos).toContain('<BellIcon muted={muted} />');
  });
});
