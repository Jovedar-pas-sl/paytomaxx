// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Checkbox, ICON_PATHS, Switch } from '@nightpay/ui';

// «Piezas II», parte A (idea 57): el interruptor guarda solo (Switch, con su
// «Sí» / «No»); la casilla espera a «Guardar» (Checkbox). Los 12 interruptores
// del panel que esperaban a «Guardar» y sus 9 casillas nativas son ya Checkbox.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Con rutas y no con URL: en jsdom, el URL global no es el de Node y readdirSync no lo admite.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const read = (...rel: string[]): string => readFileSync(join(REPO, ...rel), 'utf8').replace(/\r\n/g, '\n');
const ADMIN = ['apps', 'admin', 'src', 'components'] as const;
const PIECES2 = read('packages', 'ui', 'src', 'pieces-2.css');
const STYLES = read('packages', 'ui', 'src', 'styles.css');
const GRAFITO = read('apps', 'admin', 'src', 'styles', 'panel-grafito.css');
const SETTINGS = read('apps', 'admin', 'src', 'styles', 'panel-settings.css');
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** Los ficheros de código (no pruebas) de una carpeta, hacia dentro. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.next' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
/** Cuántas veces sale `what` en cada fichero (solo los que lo tienen), con la ruta desde la raíz del repo. */
function countIn(dirs: string[][], what: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dir of dirs) {
    for (const file of sources(join(REPO, ...dir))) {
      const n = readFileSync(file, 'utf8').match(what)?.length ?? 0;
      if (n > 0) out[relative(REPO, file).replace(/\\/g, '/')] = n;
    }
  }
  return out;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (el: ReactElement) => act(() => root.render(el));

describe('Switch: el interruptor que guarda al tocarlo', () => {
  it('role="switch" con su estado, su nombre y su ayuda; dentro, «Sí» o «No» escrito', () => {
    const html = renderToStaticMarkup(<Switch label="Vibración" hint="Solo en Android." checked onChange={() => undefined} />);
    expect(html).toMatch(/^<div class="np-switch-row"><div class="np-switch-row-text"><span class="np-switch-row-label">Vibración<\/span>/);
    const hint = /<span id="([^"]+)" class="np-switch-row-hint">Solo en Android\.<\/span>/.exec(html);
    expect(hint).not.toBeNull();
    expect(html).toContain(`<button type="button" role="switch" aria-checked="true" aria-label="Vibración" aria-describedby="${hint![1]}" class="np-switch">`);
    expect(html).toContain('<span class="np-switch-thumb" aria-hidden="true"></span><span class="np-switch-text" aria-hidden="true">Sí</span>');
    const off = renderToStaticMarkup(<Switch label="Sonido" checked={false} onChange={() => undefined} />);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('aria-hidden="true">No</span>');
    expect(off).not.toContain('aria-describedby');
    expect(off).not.toContain('np-switch-row-hint');
  });

  it('un toque: onChange con lo contrario (quien lo usa guarda y dice «Guardado»)', () => {
    const onChange = vi.fn();
    render(<Switch label="Sonido" checked={false} onChange={onChange} />);
    act(() => host.querySelector<HTMLButtonElement>('.np-switch')!.click());
    expect(onChange.mock.calls).toEqual([[true]]);
    render(<Switch label="Sonido" checked onChange={onChange} />);
    act(() => host.querySelector<HTMLButtonElement>('.np-switch')!.click());
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('apagado no hace nada', () => {
    const onChange = vi.fn();
    render(<Switch label="Sonido" checked={false} onChange={onChange} disabled />);
    const button = host.querySelector<HTMLButtonElement>('.np-switch')!;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('84 × 44, con la letra de la escala (14/600) y sin las variables del panel', () => {
    const css = rule(PIECES2, '.np-switch');
    expect(css).toContain('width: 5.25rem;');
    expect(css).toContain('height: 2.75rem;');
    expect(css).toContain('font-size: var(--np-fs-14);');
    expect(css).toContain('font-weight: 600;');
    expect(code(PIECES2)).not.toContain('--gf-');
    const on = rule(PIECES2, ".np-switch[aria-checked='true']");
    expect(on).toContain('background: var(--np-success);');
    expect(on).toContain('color: var(--np-on-success);');
  });

  it('apagado: neutro, sin transparencia', () => {
    const off = rule(PIECES2, '.np-switch:disabled');
    expect(off).toContain('background: var(--np-disabled-bg);');
    expect(off).toContain('color: var(--np-disabled-ink);');
    expect(off).toContain('border-color: var(--np-disabled-edge);');
    expect(rule(PIECES2, '.np-switch:disabled .np-switch-thumb')).toContain('background: var(--np-disabled-ink);');
  });

  it('el área de toque, con top, bottom, left y right (inset: es de Chrome 87)', () => {
    expect(PIECES2).toMatch(
      /@media \(max-width: 640px\) \{\s*\.np-switch::before \{\s*content: '';\s*position: absolute;\s*top: -0\.25rem;\s*right: 0;\s*bottom: -0\.25rem;\s*left: 0;\s*\}/,
    );
  });

  it('la tinta sobre el verde (--np-on-success) sube a styles.css, en los dos temas', () => {
    const dark = STYLES.slice(STYLES.indexOf(":root,\n[data-theme='dark'] {"), STYLES.indexOf("[data-theme='light'] {"));
    const light = STYLES.slice(STYLES.indexOf("[data-theme='light'] {"), STYLES.indexOf("html[data-contrast='sala'] {"));
    expect(dark).toContain('--np-on-success: #0b2a17;');
    expect(light).toContain('--np-on-success: #f7f5f0;');
    expect(GRAFITO).not.toContain('--np-on-success');
  });

  it('el panel ya no tiene su copia: ni las reglas del interruptor ni su opacidad', () => {
    for (const css of [GRAFITO, SETTINGS]) expect(code(css)).not.toMatch(/\.np-switch(?!-row)/);
    expect(code(SETTINGS)).not.toContain('opacity: 0.55');
    // En una tarjeta de Ajustes, cada fila con interruptor sigue con su raya, como las demás filas.
    expect(SETTINGS).toMatch(/\.np-set-row,\n\.np-set-card \.np-switch-row \{/);
    expect(SETTINGS).toMatch(/\.np-set-head \+ \.np-set-row,\n\.np-set-head \+ \.np-switch-row \{/);
  });
});

describe('Checkbox: la casilla que espera a «Guardar»', () => {
  it('una casilla nativa dentro de su etiqueta: la fila entera se toca', () => {
    const html = renderToStaticMarkup(<Checkbox label="Vibración" hint="Solo en Android." checked onChange={() => undefined} />);
    expect(html).toMatch(/^<label class="np-checkbox"><span class="np-checkbox-box"><input type="checkbox" /);
    expect(html).toContain('checked=""');
    const hint = /<span id="([^"]+)" class="np-checkbox-hint">Solo en Android\.<\/span>/.exec(html);
    expect(hint).not.toBeNull();
    expect(html).toContain(`aria-describedby="${hint![1]}"`);
    expect(html).toContain('<span class="np-checkbox-label">Vibración</span>');
    // Sin role ni estados a mano: los da la casilla nativa.
    expect(html).not.toMatch(/role=|aria-checked/);
  });

  it('el ✓ es el Icon check, hermano de la casilla y encima de ella', () => {
    const html = renderToStaticMarkup(<Checkbox label="Sonido" checked onChange={() => undefined} />);
    const mark = /<input [^>]*\/><svg ([^>]*)>(.*?)<\/svg><\/span>/.exec(html);
    expect(mark).not.toBeNull();
    expect(mark![1]).toContain('width="20" height="20"');
    expect(mark![1]).toContain('aria-hidden="true"');
    expect([...mark![2]!.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])).toEqual([...ICON_PATHS.check]);
    const css = rule(PIECES2, '.np-checkbox-box > svg');
    expect(css).toContain('position: absolute;');
    expect(css).toContain('pointer-events: none;');
    expect(css).toContain('display: none;');
    expect(css).toContain('color: var(--np-on-chosen);');
    expect(PIECES2).toMatch(/\.np-checkbox-box > input:checked \+ svg,\n\.np-checkbox-box > input\[data-mixed\] \+ svg \{\s*display: block;/);
  });

  it('tocar el texto la marca: onChange(true); y desmarca: onChange(false)', () => {
    const onChange = vi.fn();
    render(<Checkbox label="Vibración" checked={false} onChange={onChange} />);
    act(() => host.querySelector<HTMLElement>('.np-checkbox-label')!.click());
    expect(onChange.mock.calls).toEqual([[true]]);
    // Sin que quien la usa lo guarde, no cambia sola.
    expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
    render(<Checkbox label="Vibración" checked onChange={onChange} />);
    expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    act(() => host.querySelector<HTMLInputElement>('input')!.click());
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('apagada: no cambia y se ve apagada sin transparencias', () => {
    const onChange = vi.fn();
    render(<Checkbox label="Activa (puede crear cobros)" checked onChange={onChange} disabled />);
    const input = host.querySelector<HTMLInputElement>('input')!;
    expect(input.disabled).toBe(true);
    expect(host.querySelector('label')!.hasAttribute('data-disabled')).toBe(true);
    act(() => host.querySelector<HTMLElement>('.np-checkbox-label')!.click());
    expect(onChange).not.toHaveBeenCalled();
    const off = rule(PIECES2, '.np-checkbox-box > input:disabled');
    expect(off).toContain('border-color: var(--np-disabled-edge);');
    expect(off).toContain('background: var(--np-disabled-bg);');
    expect(rule(PIECES2, '.np-checkbox[data-disabled] .np-checkbox-label')).toContain('color: var(--np-disabled-ink);');
  });

  it('`indeterminate` (unas sí y otras no): la casilla lo dice y lleva una raya en vez del ✓', () => {
    render(<Checkbox label="Todas" checked={false} indeterminate onChange={() => undefined} />);
    const input = host.querySelector<HTMLInputElement>('input')!;
    expect(input.indeterminate).toBe(true);
    expect(input.hasAttribute('data-mixed')).toBe(true);
    expect(Array.from(host.querySelectorAll('svg path')).map((p) => p.getAttribute('d'))).toEqual([...ICON_PATHS.minus]);
    render(<Checkbox label="Todas" checked onChange={() => undefined} />);
    expect(host.querySelector<HTMLInputElement>('input')!.indeterminate).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input')!.hasAttribute('data-mixed')).toBe(false);
  });

  it('la etiqueta y la ayuda pueden llevar algo más que texto (una lista de cambios)', () => {
    const html = renderToStaticMarkup(
      <Checkbox
        label="Ponerlo como la referencia"
        hint={
          <ul>
            <li>Precio: 10 € → 12 €</li>
          </ul>
        }
        checked={false}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('class="np-checkbox-hint"><ul><li>Precio: 10 € → 12 €</li></ul></span>');
  });

  it('caja de 24 con filete de 2 px y radio 6, sin el dibujo del navegador; marcada, en el color de lo elegido', () => {
    const box = rule(PIECES2, '.np-checkbox-box > input');
    expect(box).toMatch(/-webkit-appearance: none;\s*appearance: none;/);
    expect(box).toContain('width: 24px;');
    expect(box).toContain('height: 24px;');
    expect(box).toContain('border: 2px solid var(--np-border-hi);');
    expect(box).toContain('border-radius: var(--np-r-xs);');
    const on = PIECES2.slice(PIECES2.indexOf('.np-checkbox-box > input:checked,'));
    expect(on.slice(0, on.indexOf('}'))).toMatch(/\.np-checkbox-box > input:checked,\n\.np-checkbox-box > input\[data-mixed\] \{\s*border-color: var\(--np-chosen\);\s*background: var\(--np-chosen\);/);
  });

  it('la fila mide 44 o más y enseña que se toca', () => {
    const row = rule(PIECES2, '.np-checkbox');
    expect(row).toContain('min-height: 2.75rem;');
    expect(row).toContain('cursor: pointer;');
  });

  it('no va en staff.css (allí una prueba prohíbe «np-check»)', () => {
    expect(read('packages', 'ui', 'src', 'staff.css')).not.toContain('np-check');
  });
});

describe('ni el interruptor ni la casilla se apagan con transparencia', () => {
  it('ninguna regla suya lleva opacity', () => {
    const rules = [...code(PIECES2).matchAll(/([^{}]*\.np-(?:switch|checkbox)[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(15);
    for (const m of rules) expect(m[2], m[1]!.trim()).not.toMatch(/opacity/);
  });
});

describe('en el panel', () => {
  const CHECKBOXES: Record<string, number> = {
    // Esperaban a «Guardar» con un interruptor (12).
    'settings/NightPanel.tsx': 4,
    'settings/RulesPanel.tsx': 1,
    'settings/SectionsPanel.tsx': 1,
    'party/PartySettingsSection.tsx': 1,
    'CartaPanel.tsx': 2,
    'EditOperatorForm.tsx': 1,
    'TerminalsPanel.tsx': 2,
    // Casillas nativas (9).
    'BankReconPanel.tsx': 2,
    'BankRefundModal.tsx': 1,
    'CartaTemplate.tsx': 1,
    'OnboardingForm.tsx': 1,
    'OperatorsPanel.tsx': 1,
    'party/StallsSection.tsx': 3,
    // Pagar a todas (entrega 11 B): «Todas», cada fila, «Ya he pagado…» y la de «Marcar pagado» (4).
    'PayoutBatchList.tsx': 2,
    'PayoutBatchReview.tsx': 1,
    'PayoutConfirmModal.tsx': 1,
  };

  it('25 <Checkbox: los 12 que esperaban a «Guardar», las 9 casillas nativas y las 4 de pagar a todas', () => {
    const found = countIn([[...ADMIN]], /<Checkbox\b/g);
    const expected = Object.fromEntries(Object.entries(CHECKBOXES).map(([file, n]) => [`apps/admin/src/components/${file}`, n]));
    expect(found).toEqual(expected);
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(25);
  });

  it('casillas nativas, solo las que tocan a otras entregas (y la pieza)', () => {
    const found = countIn(
      [
        ['apps', 'admin', 'src'],
        ['apps', 'operator', 'src'],
        ['apps', 'tpv', 'src'],
        ['apps', 'web-client', 'src'],
        ['packages', 'ui', 'src'],
      ],
      /type="checkbox"/g,
    );
    expect(found).toEqual({
      // Cerrar la noche (entrega 10).
      'apps/admin/src/components/NightCashStep.tsx': 1,
      'apps/admin/src/components/NightCloseScreen.tsx': 1,
      // Las fichas de sección de cada puesto: se guardan al tocar, con su «Guardado».
      'apps/admin/src/components/settings/PostRulesCard.tsx': 1,
      // La consola de OxioPay, fuera del encargo.
      'apps/admin/src/components/superadmin/ui.tsx': 1,
      // El alta de la compañera (entrega 6).
      'apps/operator/src/app/onboarding/[token]/SelfOnboardingClient.tsx': 1,
      'packages/ui/src/components/Checkbox.tsx': 1,
    });
  });

  it('fuera ToggleSwitch: ni el fichero, ni su SwitchLine, ni quien los nombre', () => {
    expect(existsSync(join(REPO, ...ADMIN, 'ToggleSwitch.tsx'))).toBe(false);
    expect(countIn([['apps', 'admin', 'src'], ['apps', 'operator', 'src'], ['packages', 'ui', 'src']], /ToggleSwitch|SwitchLine/g)).toEqual({});
  });

  it('los que guardan al tocar son el Switch común: Ajustes lo reexporta, y lo usan los puestos y «Agotado esta noche»', () => {
    expect(read(...ADMIN, 'settings', 'SettingsBits.tsx')).toContain("export { Switch } from '@nightpay/ui';");
    const posts = read(...ADMIN, 'settings', 'PostRulesCard.tsx');
    expect(posts).toContain('<Switch key={f.key} label={f.label} checked={rule[f.key]} onChange={(next) => void save(p.code, { [f.key]: next })} disabled={busy} />');
    expect(posts).toContain('<StatusLine saved={saved} error={error} />');
    const carta = read(...ADMIN, 'CartaPanel.tsx');
    expect(carta).toContain('<Switch label="Agotado esta noche" checked={item.soldOut === true} onChange={() => void toggleSoldOut(item)} />');
    expect(carta).not.toContain('role="switch"');
  });

  it('las casillas del panel conservan su texto', () => {
    const night = read(...ADMIN, 'settings', 'NightPanel.tsx');
    for (const label of ['Desordenar las cifras', 'Vibración', 'Sonido', 'Modo sala (contraste alto)']) expect(night, label).toContain(`label="${label}"`);
    expect(night).toContain('<Checkbox label="Sonido" checked={current.feedbackSound} onChange={(v) => update({ feedbackSound: v })} />');
    expect(read(...ADMIN, 'TerminalsPanel.tsx')).toContain('<Checkbox label="Activo" checked={active} onChange={setActive} />');
    expect(read(...ADMIN, 'BankRefundModal.tsx')).toContain('<Checkbox label="Sí, es otra devolución distinta" checked={confirmed} onChange={setConfirmed} />');
    expect(read(...ADMIN, 'BankReconPanel.tsx')).toContain('<Checkbox label="Ver también lo que cuadra" checked={showAll} onChange={setShowAll} />');
    const stalls = read(...ADMIN, 'party', 'StallsSection.tsx');
    expect(stalls).toContain('label="Barra propia (todo para la organización; no se le paga)"');
    expect(stalls).toContain('disabled={bpsFixed}');
  });
});
