// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, useConfirm } from '@nightpay/ui';
import { resetSheetHistory } from '../../../../packages/ui/src/lib/sheet';

// «Piezas II», parte A (idea 49): la pregunta antes de lo que no se deshace
// (ConfirmDialog y useConfirm) y el botón de mantener pulsado, que ya se ve en
// un datáfono viejo. Quién pregunta con qué (los 10 window.confirm del panel y
// las ventanas de dinero) es de la parte B.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UI = '../../../../packages/ui/src/';
const PIECES2 = read(`${UI}pieces-2.css`);
const STAFF = read(`${UI}staff.css`);
const code = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const noop = () => undefined;

/** Los botones del pie, en el orden del DOM: su variante, su tamaño y su texto. */
function footButtons(html: string): Array<{ variant: string; size: string; text: string; tag: string }> {
  const foot = html.slice(html.indexOf('data-np-foot'));
  return [...foot.matchAll(/<button([^>]*)>(?:<span[^>]*>)*([^<]*)/g)].map((m) => ({
    tag: m[1]!,
    variant: /data-variant="([^"]+)"/.exec(m[1]!)![1]!,
    size: /data-size="([^"]+)"/.exec(m[1]!)![1]!,
    text: m[2]!,
  }));
}

describe('ConfirmDialog: el marcado', () => {
  const html = renderToStaticMarkup(
    <ConfirmDialog open title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" cancelLabel="No bloquear" onConfirm={noop} onClose={noop}>
      Ya no podrá pagar con ella.
    </ConfirmDialog>,
  );

  it('es una hoja (ventana de 26rem) que avisa: role="alertdialog", con la consecuencia como descripción', () => {
    expect(html).toContain('class="np-hoja np-modal-panel"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('style="--np-hoja-w:26rem"');
    expect(html).toContain('class="np-hoja-titulo">¿Bloquear la ficha 522?</h3>');
    const body = /<p id="([^"]+)" class="np-pregunta-texto">Ya no podrá pagar con ella\.<\/p>/.exec(html);
    expect(body).not.toBeNull();
    expect(html).toContain(`aria-describedby="${body![1]}"`);
  });

  it('en el pie y en el DOM, primero «Volver» (secundario y con el foco) y después la acción, los dos grandes', () => {
    const buttons = footButtons(html);
    expect(buttons.map((b) => b.text)).toEqual(['No bloquear', 'Bloquear ficha']);
    expect(buttons.map((b) => b.variant)).toEqual(['ghost', 'danger']);
    expect(buttons.map((b) => b.size)).toEqual(['lg', 'lg']);
    expect(buttons[0]!.tag).toContain('autofocus');
    expect(buttons[1]!.tag).not.toContain('autofocus');
    expect(html).toMatch(/<div class="np-hoja-pie" data-np-foot=""><div class="np-pregunta-pie">/);
  });

  it('sin decirlo: «Volver» y de peligro; con `tone="primary"`, la acción es el botón principal', () => {
    const plain = renderToStaticMarkup(<ConfirmDialog open title="¿Desvincular este datáfono?" confirmLabel="Desvincular" onConfirm={noop} onClose={noop} />);
    expect(footButtons(plain).map((b) => [b.text, b.variant])).toEqual([
      ['Volver', 'ghost'],
      ['Desvincular', 'danger'],
    ]);
    // Sin consecuencia que leer, no apunta a nada.
    expect(plain).not.toContain('aria-describedby');
    expect(plain).not.toContain('np-pregunta-texto');
    const primary = renderToStaticMarkup(
      <ConfirmDialog open tone="primary" title="¿Preparar 200 pulseras?" confirmLabel="Preparar 200 pulseras" onConfirm={noop} onClose={noop} />,
    );
    expect(footButtons(primary)[1]).toMatchObject({ text: 'Preparar 200 pulseras', variant: 'primary' });
  });

  it('cerrada no pinta nada', () => {
    expect(renderToStaticMarkup(<ConfirmDialog open={false} title="¿Seguro?" confirmLabel="Sí" onConfirm={noop} onClose={noop} />)).toBe('');
  });

  it('con `busy`: la acción trabajando con su palabra, «Volver» apagado', () => {
    const busy = renderToStaticMarkup(
      <ConfirmDialog open busy busyLabel="Bloqueando" title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" onConfirm={noop} onClose={noop} />,
    );
    const foot = busy.slice(busy.indexOf('data-np-foot'));
    const [cancel, action] = [...foot.matchAll(/<button([^>]*)>/g)].map((m) => m[1]!);
    expect(cancel).toContain('disabled=""');
    expect(action).toContain('disabled=""');
    expect(action).toContain('data-loading="true"');
    expect(foot).toContain('Bloqueando');
    expect(foot).not.toContain('Bloquear ficha');
  });
});

describe('ConfirmDialog: el pie', () => {
  it('hasta 640 px, apilados a lo ancho con la acción arriba; desde 641, lado a lado e igual de anchos', () => {
    const pie = rule(PIECES2, '.np-pregunta-pie');
    expect(pie).toContain('display: flex;');
    expect(pie).toContain('flex-direction: column-reverse;');
    const wide = PIECES2.slice(PIECES2.indexOf('.np-pregunta-pie {'));
    const media = wide.slice(wide.indexOf('@media (min-width: 641px) {'));
    expect(rule(media, '.np-pregunta-pie')).toContain('flex-direction: row;');
    expect(rule(media, '.np-hoja-pie .np-pregunta-pie > .np-btn[data-size]')).toContain('flex: 1 1 0%;');
  });

  it('las etiquetas no se cortan: el botón crece (y gana a la regla de tamaño de .np-btn, también en la app táctil)', () => {
    const button = rule(PIECES2, '.np-hoja-pie .np-pregunta-pie > .np-btn[data-size]');
    expect(button).toContain('white-space: normal;');
    expect(button).toContain('height: auto;');
    expect(button).toContain('min-height: 3rem;');
    expect(button).toContain('width: 100%;');
    expect(rule(PIECES2, '.np-touch .np-hoja-pie .np-pregunta-pie > .np-btn[data-size]')).toContain('min-height: 3.5rem;');
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // Aquí no se mira el historial (ui-hoja.test.tsx): quieto, para que nada llegue a destiempo.
  resetSheetHistory();
  for (const method of ['pushState', 'replaceState', 'back'] as const) vi.spyOn(window.history, method).mockImplementation(noop);
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const render = (el: ReactElement) => act(async () => root.render(el));
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text)!;
const click = (el: HTMLElement) => act(async () => el.click());
const esc = () => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));

describe('ConfirmDialog: al usarla', () => {
  it('se abre con el foco en «Volver»: Intro sin mirar no hace lo peligroso', async () => {
    await render(
      <ConfirmDialog open title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" onConfirm={noop} onClose={noop}>
        Ya no podrá pagar con ella.
      </ConfirmDialog>,
    );
    expect(document.activeElement).toBe(button('Volver'));
  });

  it('confirmar llama a onConfirm y NO la cierra (la cierra quien la usa, cuando termina)', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await render(<ConfirmDialog open title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" onConfirm={onConfirm} onClose={onClose} />);
    await click(button('Bloquear ficha'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('.np-hoja')).not.toBeNull();
  });

  it('«Volver», la ✕ y Esc piden cerrar y nada más', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await render(<ConfirmDialog open title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" onConfirm={onConfirm} onClose={onClose} />);
    await click(button('Volver'));
    await click(host.querySelector<HTMLButtonElement>('.np-hoja-cerrar')!);
    await esc();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('con `busy` nada la cierra: ni Esc, ni la ✕, ni «Volver»; y la acción no se repite', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    await render(
      <ConfirmDialog open busy busyLabel="Bloqueando" title="¿Bloquear la ficha 522?" confirmLabel="Bloquear ficha" onConfirm={onConfirm} onClose={onClose} />,
    );
    await esc();
    await click(host.querySelector<HTMLButtonElement>('.np-hoja-cerrar')!);
    const [cancel, action] = Array.from(host.querySelectorAll<HTMLButtonElement>('.np-pregunta-pie button'));
    expect(cancel!.disabled).toBe(true);
    expect(action!.disabled).toBe(true);
    await click(cancel!);
    await click(action!);
    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('useConfirm: await confirm({ title, body, confirmLabel }) → true / false', () => {
  function Asker({ onAnswer }: { onAnswer: (who: string, ok: boolean) => void }) {
    const [confirm, dialog] = useConfirm();
    return (
      <>
        <button
          type="button"
          onClick={() => void confirm({ title: '¿Bloquear la ficha 522?', body: 'Ya no podrá pagar con ella.', confirmLabel: 'Bloquear ficha', cancelLabel: 'No bloquear' }).then((ok) => onAnswer('ficha', ok))}
        >
          preguntar
        </button>
        <button type="button" onClick={() => void confirm({ title: '¿Preparar 200 pulseras?', confirmLabel: 'Preparar 200 pulseras', tone: 'primary' }).then((ok) => onAnswer('pulseras', ok))}>
          otra
        </button>
        <output>{dialog === null ? 'cerrada' : 'abierta'}</output>
        {dialog}
      </>
    );
  }
  const state = () => host.querySelector('output')!.textContent;

  it('cerrada, `dialog` es null; al preguntar sale la ventana con su título, su consecuencia y sus botones', async () => {
    await render(<Asker onAnswer={noop} />);
    expect(state()).toBe('cerrada');
    expect(host.querySelector('.np-hoja')).toBeNull();
    await click(button('preguntar'));
    expect(state()).toBe('abierta');
    expect(host.querySelector('[role="alertdialog"] .np-hoja-titulo')!.textContent).toBe('¿Bloquear la ficha 522?');
    expect(host.querySelector('.np-pregunta-texto')!.textContent).toBe('Ya no podrá pagar con ella.');
    expect(Array.from(host.querySelectorAll('.np-pregunta-pie button')).map((b) => b.textContent)).toEqual(['No bloquear', 'Bloquear ficha']);
  });

  it('la acción responde true y la cierra; un segundo toque ya no responde nada (UNA vez)', async () => {
    const onAnswer = vi.fn();
    await render(<Asker onAnswer={onAnswer} />);
    await click(button('preguntar'));
    const action = button('Bloquear ficha');
    await act(async () => {
      action.click();
      action.click();
    });
    expect(onAnswer.mock.calls).toEqual([['ficha', true]]);
    expect(state()).toBe('cerrada');
  });

  it('«Volver» y Esc responden false', async () => {
    const onAnswer = vi.fn();
    await render(<Asker onAnswer={onAnswer} />);
    await click(button('preguntar'));
    await click(button('No bloquear'));
    expect(state()).toBe('cerrada');
    await click(button('preguntar'));
    await esc();
    expect(onAnswer.mock.calls).toEqual([
      ['ficha', false],
      ['ficha', false],
    ]);
    expect(state()).toBe('cerrada');
  });

  it('otra pregunta da false a la anterior y se queda la nueva', async () => {
    const onAnswer = vi.fn();
    await render(<Asker onAnswer={onAnswer} />);
    await click(button('preguntar'));
    await click(button('otra'));
    expect(onAnswer.mock.calls).toEqual([['ficha', false]]);
    expect(host.querySelector('.np-hoja-titulo')!.textContent).toBe('¿Preparar 200 pulseras?');
    // Sin decirlo, «Volver»; y su tono.
    expect(button('Volver')).toBeDefined();
    expect(button('Preparar 200 pulseras').dataset.variant).toBe('primary');
    await click(button('Preparar 200 pulseras'));
    expect(onAnswer.mock.calls).toEqual([
      ['ficha', false],
      ['pulseras', true],
    ]);
  });

  it('si la pantalla se va con la pregunta abierta, responde false (quien espera no se queda colgado)', async () => {
    const onAnswer = vi.fn();
    await render(<Asker onAnswer={onAnswer} />);
    await click(button('preguntar'));
    await render(<p>otra pantalla</p>);
    expect(onAnswer.mock.calls).toEqual([['ficha', false]]);
  });
});

describe('HoldButton: mantener pulsado, también en un datáfono viejo', () => {
  it('la barra se coloca con top, bottom y left (inset: es de Chrome 87)', () => {
    const fill = rule(STAFF, '.np-hold-fill');
    expect(fill).not.toMatch(/inset\s*:/);
    for (const side of ['top', 'bottom', 'left']) expect(fill).toContain(`${side}: 0;`);
    expect(fill).toContain('width: 0;');
  });

  it('los fondos, en rgba() con comas; color-mix(), solo donde se entiende', () => {
    expect(rule(STAFF, '.np-hold')).toContain('background: rgba(255, 107, 107, 0.1);');
    expect(rule(STAFF, '.np-hold-fill')).toContain('background: rgba(255, 107, 107, 0.22);');
    for (const selector of ['.np-hold', '.np-hold-fill']) expect(rule(STAFF, selector), selector).not.toContain('color-mix(');
    expect(code(STAFF)).toMatch(
      /@supports \(color: color-mix\(in srgb, red, blue\)\) \{\s*\.np-hold \{\s*background: color-mix\(in srgb, var\(--np-danger\) 10%, var\(--np-surface\)\);\s*\}\s*\.np-hold-fill \{\s*background: color-mix\(in srgb, var\(--np-danger\) 22%, transparent\);\s*\}\s*\}/,
    );
  });

  it('.np-hold-fill.on no cambia: se llena en 1,2 s', () => {
    expect(STAFF).toMatch(/\.np-hold-fill\.on \{\s*width: 100%;\s*transition: width var\(--np-hold-ms, 1200ms\) linear;\s*\}/);
  });
});
