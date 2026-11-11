import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { METHOD_ARM_MS, methodArmed } from './reception-desk';

// Auditoría S-1a: en recepción, un doble toque en el importe («50 €») hacía
// que el segundo toque cayera en «Efectivo» de la pantalla siguiente, que
// carga sin más. Ahora «¿Cómo paga?» no atiende toques el primer medio
// segundo (comprobado en onPick, no solo con CSS) y sus opciones empiezan por
// debajo de donde acaban los importes (a 360×740: importes 248–320,
// «Efectivo» desde 336, con la ayuda abierta o cerrada; medido en la demo).

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('«¿Cómo paga?» y el doble toque', () => {
  it('no cuenta un toque en el primer medio segundo', () => {
    const shown = 1_000_000;
    expect(METHOD_ARM_MS).toBe(500);
    expect(methodArmed(shown, shown)).toBe(false);
    expect(methodArmed(shown, shown + 120)).toBe(false); // el segundo toque de un doble toque
    expect(methodArmed(shown, shown + 499)).toBe(false);
    expect(methodArmed(shown, shown + 500)).toBe(true);
    expect(methodArmed(shown, shown + 4_000)).toBe(true);
  });

  it('lo comprueba al tocar «Efectivo» o «Tarjeta», con la hora a la que salió la pantalla', () => {
    const steps = read('../components/reception/desk/DeskSteps.tsx');
    const method = steps.slice(steps.indexOf('export function MethodStep('));
    expect(method).toContain('const [armedAt] = useState(() => Date.now());');
    expect(method).toMatch(/onClick=\{\(\) => \{\s*if \(methodArmed\(armedAt, Date\.now\(\)\)\) props\.onPick\(b\.method\);\s*\}\}/);
    // Nadie más llama a onPick sin pasar por la comprobación.
    expect(method.match(/props\.onPick\(/g)).toHaveLength(1);
  });

  it('las opciones empiezan por debajo de los importes también con la ayuda cerrada', () => {
    const css = read('../components/reception/desk/desk.module.css');
    const top = css.slice(css.indexOf('.methodTop {'), css.indexOf('}', css.indexOf('.methodTop {')));
    expect(top).toContain('min-height: 15.5rem');
    // Con la ficha en grande (A1), los importes de antes bajan y «Efectivo» baja con ellos.
    const withFicha = css.slice(css.indexOf(".methodTop[data-ficha='true'] {"), css.indexOf('}', css.indexOf(".methodTop[data-ficha='true'] {")));
    expect(withFicha).toContain('min-height: 19rem');
    const steps = read('../components/reception/desk/DeskSteps.tsx');
    expect(steps).toMatch(/<div className=\{s\.methodTop\} data-ficha=\{props\.ficha \? 'true' : undefined\}>\s*<div className=\{s\.bigamt\} data-tour="recep-total">[\s\S]*?<StepQuestion text="¿Cómo paga\?"/);
  });
});
