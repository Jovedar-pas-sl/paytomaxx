// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FieldError, FormError, ICON_PATHS, Input, Select } from '@nightpay/ui';

// «Piezas II», parte A (idea 51): los errores van en dos sitios fijos. Bajo el
// campo, lo que está mal en ese campo (FieldError; Input y Select lo pintan
// con su `error`). Sobre el botón principal, lo que falla al hacer (FormError,
// que ya existía). Cambiar las líneas rojas sueltas de las apps es de la parte B.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UI = '../../../../packages/ui/src/';
const PIECES = read(`${UI}pieces.css`);
const PIECES2 = read(`${UI}pieces-2.css`);

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const paths = (html: string): string[] => [...html.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!);

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
const field = () => host.querySelector<HTMLInputElement>('input')!;

describe('FieldError: el error de un campo, debajo', () => {
  const html = renderToStaticMarkup(<FieldError id="telefono-error">Faltan 2 números</FieldError>);

  it('el aspa de 20 y el texto, con su id para que el campo lo apunte', () => {
    expect(html).toMatch(/^<span id="telefono-error" class="np-field-error"><svg /);
    expect(html).toContain('width="20" height="20"');
    expect(html).toContain('aria-hidden="true"');
    expect(paths(html)).toEqual([...ICON_PATHS.error]);
    expect(html).toContain('<span>Faltan 2 números</span>');
  });

  it('sin role: no interrumpe al lector de pantalla cada vez que se teclea (se lee con el campo)', () => {
    expect(html).not.toContain('role=');
    expect(html).not.toContain('aria-live');
  });

  it('14/500 en el rojo de los textos pequeños, con su icono delante', () => {
    const css = rule(PIECES2, '.np-field-error');
    expect(css).toContain('font-size: var(--np-fs-14);');
    expect(css).toContain('font-weight: 500;');
    expect(css).toContain('color: var(--np-danger-text);');
    expect(rule(PIECES2, '.np-field-error > svg')).toContain('flex: none;');
    // El de la entrega anterior (solo el color) ya no hace falta.
    expect(PIECES).not.toContain('.np-field-error');
  });
});

describe('Input y Select con `error`', () => {
  it('Input: pinta el FieldError bajo el campo, tal cual, y el campo queda marcado y enlazado', () => {
    render(<Input label="Teléfono" error="Faltan 2 números" />);
    const error = host.querySelector('.np-field-error')!;
    expect(error.tagName).toBe('SPAN');
    expect(error.textContent).toBe('Faltan 2 números');
    expect(error.querySelector('svg')!.getAttribute('width')).toBe('20');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe(error.id);
    // Debajo de la caja del campo.
    expect(host.querySelector('.np-field')!.lastElementChild).toBe(error);
  });

  it('el error sustituye a la pista mientras dura', () => {
    render(<Input label="Teléfono" hint="Con el prefijo." error="Faltan 2 números" />);
    expect(host.querySelector('.np-field-hint')).toBeNull();
    expect(host.querySelector('.np-field-error')!.textContent).toBe('Faltan 2 números');
    render(<Input label="Teléfono" hint="Con el prefijo." />);
    expect(host.querySelector('.np-field-error')).toBeNull();
    expect(host.querySelector('.np-field-hint')!.textContent).toBe('Con el prefijo.');
  });

  it('no se esconde al escribir: se va cuando quien valida deja de mandarlo', () => {
    function Phone() {
      const [value, setValue] = useState('6001122');
      return <Input label="Teléfono" value={value} onChange={(e) => setValue(e.target.value)} error={value.length < 9 ? `Faltan ${9 - value.length} números` : undefined} />;
    }
    const type = (text: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), text);
        field().dispatchEvent(new Event('input', { bubbles: true }));
      });
    render(<Phone />);
    expect(host.querySelector('.np-field-error')!.textContent).toBe('Faltan 2 números');
    type('60011223');
    expect(host.querySelector('.np-field-error')!.textContent).toBe('Faltan 1 números');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    type('600112233');
    expect(host.querySelector('.np-field-error')).toBeNull();
    expect(field().hasAttribute('aria-invalid')).toBe(false);
  });

  it('sin error, nada: ni marca, ni descripción, ni icono', () => {
    render(<Input label="Teléfono" />);
    expect(field().hasAttribute('aria-invalid')).toBe(false);
    expect(field().hasAttribute('aria-describedby')).toBe(false);
    expect(host.querySelector('.np-field-error')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();
  });

  it('Select: igual', () => {
    render(
      <Select label="Sección" error="Elige una sección.">
        <option value="">—</option>
      </Select>,
    );
    const select = host.querySelector('select')!;
    const error = host.querySelector('.np-field-error')!;
    expect(error.textContent).toBe('Elige una sección.');
    expect(error.querySelector('svg')).not.toBeNull();
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(error.id);
    render(
      <Select label="Sección">
        <option value="">—</option>
      </Select>,
    );
    expect(host.querySelector('select')!.hasAttribute('aria-invalid')).toBe(false);
    expect(host.querySelector('.np-field-error')).toBeNull();
  });

  it('el campo con error: filete rojo de 2 px (borde + 1 px por dentro), también con el foco', () => {
    expect(PIECES2).toMatch(
      /\.np-field-input\[aria-invalid='true'\],\n\.np-field-input\[aria-invalid='true'\]:focus \{\s*border-color: var\(--np-danger\) !important;\s*box-shadow: inset 0 0 0 1px var\(--np-danger\) !important;\s*\}/,
    );
    // Gana al foco general de los campos (styles.css y el del panel), que también van con !important.
    expect(read(`${UI}styles.css`)).toMatch(/input:focus,\nselect:focus,\ntextarea:focus \{\s*border-color: var\(--np-accent\) !important;/);
  });
});

describe('FormError: lo que falla al hacer, sobre el botón (no cambia)', () => {
  it('caja con su «!» y role="alert": se anuncia al aparecer', () => {
    const html = renderToStaticMarkup(<FormError id="login-error">El banco no contesta. Prueba otra vez.</FormError>);
    expect(html).toMatch(/^<p role="alert" id="login-error" class="np-form-error">/);
    expect(paths(html)).toEqual([...ICON_PATHS.alert]);
    expect(html).toContain('<span>El banco no contesta. Prueba otra vez.</span>');
  });

  it('se queda hasta el siguiente intento: no tiene reloj', () => {
    expect(read(`${UI}components/FormError.tsx`)).not.toMatch(/setTimeout|useEffect|useState/);
  });
});
