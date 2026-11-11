import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Grafito 3 · punto 11: restos del aspecto antiguo.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('«Mi QR» con 0 invitaciones', () => {
  it('no dibuja el trazo del aro (su extremo redondo era un punto suelto)', () => {
    const src = read('../components/cobrar/MiQr.tsx');
    expect(src).toMatch(/\{dash > 0 \? \(\s*<circle\s+className=\{styles\.rf\}/);
  });
});

describe('la caja del reparto en el PAGADO de la invitación', () => {
  const css = read('../components/cobrar/cobrar.module.css');
  it('lleva la misma caja que «cómo se pagó» y aire alrededor', () => {
    const at = css.indexOf('.psplit {');
    const box = css.slice(at, css.indexOf('}', at));
    expect(box).toContain('border-radius: 1rem');
    expect(box).toContain('var(--np-outcome-how-line');
    expect(box).toContain('margin-top: 0.5rem');
    expect(css).toMatch(/\.psplit > span \{\s*padding: 0\.75rem 1rem;/);
    expect(css).toMatch(/\.outcomeSplit \{\s*width: min\(26rem, 100%\);\s*margin: 0\.75rem auto 0;/);
  });
});

describe('volver a entrar, el alta del personal y el alta con enlace', () => {
  const FILES = [
    '../components/ReloginSheet.tsx',
    '../app/onboarding/[token]/SelfOnboardingClient.tsx',
    '../app/onboarding/[token]/PayoutSection.tsx',
    '../app/accept-invite/page.tsx',
  ];
  for (const f of FILES) {
    it(`${f.split('/').pop()}: sin mayúsculas, sin letras espaciadas ni apretadas, sin pesos 700+`, () => {
      const text = code(read(f));
      expect(text).not.toMatch(/textTransform:\s*'uppercase'/);
      expect(text).not.toMatch(/letterSpacing:\s*'-?0\.\d+em'/);
      expect(text).not.toMatch(/fontWeight:\s*[789]00/);
    });
  }

  it('el código del saldo recién creado no va en lima (la lima es de lo que se toca)', () => {
    expect(code(read('../components/NewWalletCard.tsx'))).not.toMatch(/codeStyle[\s\S]{0,200}np-accent/);
  });
});
