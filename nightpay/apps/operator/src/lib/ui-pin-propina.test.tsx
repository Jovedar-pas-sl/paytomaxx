import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PinScreen } from '../components/cobrar/PinScreen';
import type { PinTipSetup } from './pin-tip';

// Idea 66 en la pantalla del PIN (móvil del camarero y tablet): cada propina
// dice «+3 €» y, debajo, el total con ella (sin «%»); botones de 60 px; a
// quién va, siempre y en los dos idiomas; y, si la eligió en la pantalla de
// la barra, el aviso de que sale marcada (solo entonces).

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('../components/cobrar/cobrar.module.css');
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** El cuerpo de la primera regla con ese selector exacto (desde `from`). */
function rule(css: string, selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const SETUP: PinTipSetup = {
  baseCents: 3300,
  previousCents: 0,
  maxCents: 3300,
  presets: [
    { cents: 300, percent: null },
    { cents: 600, percent: 15 },
  ],
};

function pin(props: { tipSetup?: PinTipSetup; tipToStaff?: boolean; presetFromScreen?: boolean } = {}): string {
  return renderToStaticMarkup(
    <PinScreen
      colors={[]}
      chip="Pagar con ficha"
      amountCents={3300}
      detail="Pon el PIN de tu ficha"
      tipSetup={props.tipSetup ?? SETUP}
      tipToStaff={props.tipToStaff ?? false}
      presetFromScreen={props.presetFromScreen}
      onPin={async () => null}
      onCancel={() => undefined}
    />,
  );
}

/** Los botones de la propina (el grupo de radios). */
function tipButtons(html: string): string[] {
  const group = html.slice(html.indexOf('role="radiogroup"'), html.indexOf('</div>', html.indexOf('role="radiogroup"')));
  return [...group.matchAll(/<button[^>]*>.*?<\/button>/g)].map((m) => m[0]);
}

describe('PIN: cada propina con el total', () => {
  it('«+3 €» y debajo el total con ella; «Sin propina» con el total; sin «%»', () => {
    const [none, three, six, other] = tipButtons(pin());
    expect(text(none!)).toBe('Sin propina No tip 33 €');
    expect(none).toContain('aria-label="Sin propina. Total 33\u00a0€"');
    expect(text(three!)).toBe('+3 € 36 €');
    expect(three).toContain('aria-label="Propina de 3\u00a0€. Total 36\u00a0€"');
    expect(text(six!)).toBe('+6 € 39 €');
    expect(text(other!)).toBe('Otra Other');
    expect(text(pin())).not.toContain('%');
  });

  it('un cobro de antes con propina: el total parte de lo vendido (baseCents)', () => {
    const [none, ...rest] = tipButtons(pin({ tipSetup: { ...SETUP, previousCents: 500 } }));
    expect(text(none!)).toContain('33 €');
    expect(rest.map(text)).toContain('+5 € 38 €');
  });

  it('las propinas, de 60 px (teclas de la casa); 52 y 48 en pantallas bajas', () => {
    expect(rule(CSS, '.pinTipOpt')).toMatch(/min-height: 3\.75rem;/);
    // Si no cabe: 52 px en pantallas de 760 de alto o menos, y 48 desde 700.
    expect(rule(CSS, '.pinTipOpt', CSS.indexOf('@media (max-height: 760px) {'))).toMatch(/min-height: calc\(3rem \+ 0\.25rem\);/);
    expect(rule(CSS, '.pinTipOpt', CSS.indexOf('@media (max-height: 700px) {'))).toMatch(/min-height: 3rem;/);
    // Los euros a 16/600 y el total a 14, apagado.
    expect(rule(CSS, '.pinTipOpt')).toMatch(/font: 600 var\(--np-fs-16\)/);
    expect(rule(CSS, '.pinTipOpt small')).toMatch(/font: 500 var\(--np-fs-14\)/);
    expect(rule(CSS, '.pinTipOpt small')).toMatch(/color: var\(--np-text-mute\);/);
  });
});

describe('PIN: a quién va la propina, siempre y en los dos idiomas', () => {
  it('de una chica: «La propina va entera para el personal · The whole tip goes to the staff»', () => {
    const html = pin({ tipToStaff: true });
    expect(text(html)).toContain('La propina va entera para el personal · The whole tip goes to the staff');
    expect(html).toMatch(/<span lang="en" class="_en_[^"]*">· The whole tip goes to the staff<\/span>/);
  });

  it('si no: «La propina es para el local · The tip goes to the venue»', () => {
    expect(text(pin({ tipToStaff: false }))).toContain('La propina es para el local · The tip goes to the venue');
  });

  it('sin propinas, sin la línea', () => {
    const html = renderToStaticMarkup(
      <PinScreen colors={[]} chip="c" amountCents={3300} detail="d" tipSetup={null} tipToStaff onPin={async () => null} onCancel={() => undefined} />,
    );
    expect(text(html)).not.toContain('La propina');
  });
});

describe('PIN: la propina elegida en la pantalla de la barra', () => {
  const chosen = { ...SETUP, previousCents: 300 };

  it('con presetFromScreen: el aviso, en los dos idiomas, sobre la propina (marcada)', () => {
    const html = pin({ tipSetup: chosen, presetFromScreen: true });
    expect(text(html)).toContain(
      'En la pantalla elegiste 3 € de propina. Puedes cambiarla o quitarla. · You chose a €3 tip on the screen. You can change or remove it.',
    );
    expect(html.indexOf('En la pantalla elegiste')).toBeLessThan(html.indexOf('role="radiogroup"'));
    expect(tipButtons(html)[1]).toContain('aria-checked="true"');
  });

  it('sin presetFromScreen (un cobro de antes, la tablet): marcada, pero sin aviso', () => {
    expect(text(pin({ tipSetup: chosen }))).not.toContain('En la pantalla elegiste');
    expect(text(pin({ tipSetup: chosen, presetFromScreen: false }))).not.toContain('You chose');
  });

  it('la tablet no lo pasa (allí la eligió delante); Esperando, solo si withScreenTip la marcó', () => {
    const tablet = read('../components/pantalla/TabletPin.tsx');
    expect(tablet).not.toContain('presetFromScreen');
    expect(tablet).toMatch(/tipToStaff=\{view\.tip\?\.toStaff === true\}/);
    const esperando = read('../components/cobrar/Esperando.tsx');
    expect(esperando).toMatch(/presetFromScreen=\{pinTip !== basePinTip\}/);
    expect(esperando).toMatch(/tipToStaff=\{getUser\(\)\?\.role === 'OPERATOR'\}/);
  });
});
