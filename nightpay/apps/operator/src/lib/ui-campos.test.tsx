// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Input, Select } from '@nightpay/ui';

// «Piezas I», parte B (idea 59): los campos. Etiqueta enlazada con su campo
// (label for → id), la unidad fija «€» a la derecha, «Ver» / «Ocultar» en las
// contraseñas, el campo apagado que se ve apagado sin transparencias y el error
// marcado y enlazado para el lector de pantalla (su aspecto, en la entrega 3).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const PIECES = read('../../../../packages/ui/src/pieces.css');
const ADMIN = '../../../admin/src/components/';

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
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
const field = () => host.querySelector('input')!;
const reveal = () => host.querySelector<HTMLButtonElement>('.np-field-reveal');

describe('Input: la etiqueta, enlazada con su campo', () => {
  it('div.np-field con <label for> y el <input id>, con un id propio si no llega', () => {
    render(<Input label="Nombre" />);
    const box = host.firstElementChild!;
    expect(box.tagName).toBe('DIV');
    expect(box.className).toBe('np-field');
    const label = host.querySelector('label')!;
    expect(label.textContent).toBe('Nombre');
    expect(field().id).not.toBe('');
    expect(label.htmlFor).toBe(field().id);
    // La etiqueta ya no envuelve el campo.
    expect(label.contains(field())).toBe(false);
  });

  it('respeta el id que llega', () => {
    render(<Input label="Correo" id="correo" />);
    expect(field().id).toBe('correo');
    expect(host.querySelector('label')!.htmlFor).toBe('correo');
  });

  it('la pista se lee con el campo (aria-describedby)', () => {
    render(<Input label="Clave" hint="La de tu tienda." />);
    const hint = host.querySelector('.np-field-hint')!;
    expect(hint.textContent).toBe('La de tu tienda.');
    expect(field().getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('sin etiqueta visible (solo aria-label) no pinta un <label> vacío', () => {
    render(<Input aria-label="Código del cliente" />);
    expect(host.querySelector('label')).toBeNull();
    expect(field().getAttribute('aria-label')).toBe('Código del cliente');
  });
});

describe('suffix: la unidad fija', () => {
  it('«€» a la derecha, en --np-text-mute y sin leerse; la etiqueta lo dice al lector: « en euros»', () => {
    render(<Input label="Importe" suffix="€" inputMode="decimal" />);
    const suffix = host.querySelector('.np-field-suffix')!;
    expect(suffix.textContent).toBe('€');
    expect(suffix.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.np-field-box')!.contains(suffix)).toBe(true);
    const label = host.querySelector('label')!;
    expect(label.textContent).toBe('Importe en euros');
    expect(label.querySelector('.np-sr-only')!.textContent).toBe(' en euros');
    expect(rule(PIECES, '.np-field-suffix')).toContain('color: var(--np-text-mute)');
  });

  it('el texto no pasa por debajo: padding-right de 4,5rem', () => {
    render(<Input label="Importe" suffix="€" />);
    expect(field().hasAttribute('data-end')).toBe(true);
    expect(rule(PIECES, '.np-field-input[data-end]')).toContain('padding-right: 4.5rem');
  });

  it('sin unidad, ni hueco ni texto de más', () => {
    render(<Input label="Nombre" />);
    expect(host.querySelector('.np-field-suffix')).toBeNull();
    expect(field().hasAttribute('data-end')).toBe(false);
    expect(host.querySelector('.np-sr-only')).toBeNull();
  });
});

describe('contraseña: «Ver» / «Ocultar»', () => {
  it('nace oculta, con «Ver» fuera del <label> y dentro de la caja del campo, a la derecha', () => {
    render(<Input label="Contraseña" type="password" />);
    const button = reveal()!;
    expect(field().type).toBe('password');
    expect(button.type).toBe('button');
    expect(button.textContent).toBe('Ver');
    expect(button.getAttribute('aria-label')).toBe('Ver contraseña');
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    expect(host.querySelector('label')!.contains(button)).toBe(false);
    expect(host.querySelector('.np-field-box')!.contains(button)).toBe(true);
    expect(field().hasAttribute('data-end')).toBe(true);
  });

  it('«Ver» la enseña sin corrector ni mayúsculas y en letra mono; el botón pasa a «Ocultar»', () => {
    render(<Input label="Contraseña" type="password" />);
    act(() => reveal()!.click());
    expect(field().type).toBe('text');
    expect(field().getAttribute('spellcheck')).toBe('false');
    expect(field().getAttribute('autocapitalize')).toBe('none');
    expect(field().getAttribute('autocorrect')).toBe('off');
    expect(field().hasAttribute('data-revealed')).toBe(true);
    // Una mono de verdad: --np-font-mono es Manrope (solo cifras), con la I y la l iguales.
    const revealed = rule(PIECES, '.np-field-input[data-revealed]');
    expect(revealed).toMatch(/font-family: [^;]*\bmonospace;/);
    expect(revealed).not.toContain('--np-font-mono');
    expect(reveal()!.textContent).toBe('Ocultar');
    expect(reveal()!.getAttribute('aria-label')).toBe('Ocultar contraseña');
    act(() => reveal()!.click());
    expect(field().type).toBe('password');
    expect(reveal()!.textContent).toBe('Ver');
  });

  it('al enviar su formulario se vuelve a ocultar', () => {
    render(
      <form onSubmit={(e) => e.preventDefault()}>
        <Input label="Contraseña" type="password" />
      </form>,
    );
    act(() => reveal()!.click());
    expect(field().type).toBe('text');
    act(() => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(field().type).toBe('password');
    expect(reveal()!.textContent).toBe('Ver');
  });

  it('si se desmonta enseñada, vuelve oculta', () => {
    render(<Input label="Contraseña" type="password" />);
    act(() => reveal()!.click());
    render(<p>Otra pantalla</p>);
    render(<Input label="Contraseña" type="password" />);
    expect(field().type).toBe('password');
  });

  it('mismos name y autoComplete al enseñarla', () => {
    render(<Input label="Contraseña" type="password" name="password" autoComplete="current-password" />);
    act(() => reveal()!.click());
    expect(field().name).toBe('password');
    expect(field().getAttribute('autocomplete')).toBe('current-password');
  });

  it('en Edge, solo nuestro «Ver»: su ojo, fuera (en una regla suelta: en una lista, los demás navegadores la tirarían entera)', () => {
    expect(PIECES).toMatch(/(\}|\*\/)\s*\.np-field-input::-ms-reveal \{\s*display: none;\s*\}/);
  });

  it('solo en contraseñas: ni en un PIN ni en un código', () => {
    render(<Input label="Código" inputMode="numeric" maxLength={6} />);
    expect(reveal()).toBeNull();
  });

  it('el botón: alto del campo, 44 de ancho como mínimo, 14/500 en --np-text-mute', () => {
    const css = rule(PIECES, '.np-field-reveal');
    expect(css).toMatch(/top: 0;\s*right: 0;\s*bottom: 0;/);
    expect(css).toContain('min-width: 2.75rem');
    expect(css).toContain('font-size: var(--np-fs-14)');
    expect(css).toContain('font-weight: 500');
    expect(css).toContain('color: var(--np-text-mute)');
  });
});

describe('apagado', () => {
  it('neutro y sin transparencia (el iPhone la baja por su cuenta: se deja en 1)', () => {
    render(<Input label="Nombre" disabled />);
    expect(field().disabled).toBe(true);
    const off = rule(PIECES, '.np-field-input:disabled');
    expect(off).toContain('background-color: var(--np-disabled-bg)');
    expect(off).toContain('color: var(--np-disabled-ink)');
    expect(off).toContain('border-color: var(--np-disabled-edge)');
    expect(off).toContain('cursor: not-allowed');
    expect(off).not.toMatch(/opacity: 0/);
    expect(off).toContain('opacity: 1');
  });
});

describe('error en Input y en Select: marcado y enlazado', () => {
  it('Input: aria-invalid y aria-describedby al texto del error', () => {
    render(<Input label="Importe" error="Pon un importe." />);
    const error = host.querySelector('.np-field-error')!;
    expect(error.textContent).toBe('Pon un importe.');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe(error.id);
  });

  it('Select: igual', () => {
    render(
      <Select label="Sección" error="Elige una sección.">
        <option value="">—</option>
      </Select>,
    );
    const select = host.querySelector('select')!;
    const error = host.querySelector('.np-field-error')!;
    expect(host.querySelector('label')!.htmlFor).toBe(select.id);
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(error.id);
  });

  it('respeta el aria-describedby de quien lo usa (el FormError de arriba del botón)', () => {
    render(<Input label="Contraseña" type="password" aria-invalid aria-describedby="login-error" />);
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe('login-error');
  });
});

describe('los mismos valores, ahora en pieces.css', () => {
  it('alto --np-field-h, 72 con size lg, 16/500, filete fuerte y radio pequeño', () => {
    const base = rule(PIECES, '.np-field-input');
    expect(base).toContain('height: var(--np-field-h)');
    expect(base).toContain('font-size: var(--np-fs-16)');
    expect(base).toContain('font-weight: 500');
    expect(base).toContain('border: 1px solid var(--np-border-hi)');
    expect(base).toContain('border-radius: var(--np-r-sm)');
    const lg = rule(PIECES, ".np-field-input[data-size='lg']");
    expect(lg).toContain('height: 4.5rem');
    expect(lg).toContain('font-size: var(--np-fs-28)');
    expect(rule(PIECES, ".np-field-input[aria-invalid='true']")).toContain('border-color: var(--np-danger)');
  });

  it('Input.tsx ya no pinta estilos en línea ni guarda rightSlot', () => {
    const src = read('../../../../packages/ui/src/components/Input.tsx');
    expect(src).not.toContain('rightSlot');
    expect(src).not.toMatch(/CSSProperties/);
  });
});

describe('en las apps', () => {
  const PASSWORDS = [
    `${ADMIN}LoginForm.tsx`,
    `${ADMIN}TwoFactorCard.tsx`,
    `${ADMIN}settings/PasskeysCard.tsx`,
    `${ADMIN}settings/BtcpayPanel.tsx`,
    `${ADMIN}EditOperatorForm.tsx`,
    '../components/LoginForm.tsx',
    '../components/PasskeySheet.tsx',
    '../app/accept-invite/page.tsx',
    '../../../tpv/src/components/LoginForm.tsx',
    '../../../../packages/ui/src/components/ProfileAccount.tsx',
  ];

  it('las 14 contraseñas son Input (con su «Ver»); ningún campo de contraseña ni botón «Ver» hecho a mano', () => {
    let count = 0;
    for (const file of PASSWORDS) {
      const src = read(file);
      count += (src.match(/type="password"/g) ?? []).length;
      expect(src, file).not.toMatch(/<input[^>]*type=\{?["'][^"']*password/);
      expect(src, file).not.toMatch(/showPass|Ver contraseña/);
    }
    expect(count).toBe(14);
  });

  const AMOUNTS: [string, number][] = [
    ['BankRefundModal.tsx', 1],
    ['BitcoinCashModal.tsx', 1],
    ['CartaPanel.tsx', 2],
    ['PaymentModals.tsx', 1],
    ['party/PartySettingsSection.tsx', 1],
    ['reservations/PackagesEditor.tsx', 2],
    ['settings/AlertsPanel.tsx', 1],
    ['settings/NightPanel.tsx', 2],
    ['settings/RulesPanel.tsx', 2],
    ['superadmin/VenueRulesCard.tsx', 2],
  ];

  it('los 15 importes del panel llevan «€» fijo y su etiqueta pierde «(€)» (menos «Importes rápidos (€)»)', () => {
    let total = 0;
    for (const [file, n] of AMOUNTS) {
      const src = read(`${ADMIN}${file}`);
      expect((src.match(/suffix="€"/g) ?? []).length, file).toBe(n);
      expect(src.replace('Importes rápidos (€)', ''), file).not.toContain('(€)');
      total += n;
    }
    expect(total).toBe(15);
  });

  it('el panel sigue apoyando la etiqueta sobre el filete y el buscador de fichas en fila: miran el campo nuevo (.np-field)', () => {
    const grafito = read('../../../admin/src/styles/panel-grafito.css');
    expect(grafito).toContain(':is(.np-notch, .np-set-card) .np-field:has(> .np-field-label) > .np-field-label {');
    expect(grafito).toContain('.np-fichas-bar > .np-field:first-child {');
    expect(grafito).not.toMatch(/label:has\(> span:first-child|\.np-fichas-bar > label/);
  });

  it('la etiqueta sobre el filete de un campo apagado: arriba el fondo de la tarjeta y abajo el del campo apagado, sin parche', () => {
    const grafito = read('../../../admin/src/styles/panel-grafito.css');
    // Solo en el escritorio, donde la etiqueta se apoya en el filete (el bloque de 641px).
    const wide = grafito.slice(grafito.indexOf('@media (min-width: 641px) {'));
    const notch = wide.slice(0, wide.indexOf('\n}\n'));
    expect(rule(notch, ':is(.np-notch, .np-set-card) .np-field:has(.np-field-input:disabled) > .np-field-label')).toContain(
      'background: linear-gradient(var(--np-field-bg) 0.6875rem, var(--np-disabled-bg) 0.6875rem)',
    );
  });

  it('Precio, Personas y Máximo de un paquete: en rejilla con su hueco también en Chrome 64 (grid-gap, no gap)', () => {
    const src = read(`${ADMIN}reservations/PackagesEditor.tsx`);
    const row = src.match(/const fieldsRow: CSSProperties = \{[^}]*\}/)![0];
    expect(row).toContain("gridGap: '0.5rem'");
    expect(row).not.toMatch(/[{\s,]gap:/);
  });

  it('la parte N de un pack: «Importe de la parte N en euros», sin ejemplo', () => {
    const carta = read(`${ADMIN}CartaPanel.tsx`);
    expect(carta).toContain('aria-label={`Importe de la parte ${i + 1} en euros`}');
    expect(carta).not.toContain('placeholder="€"');
  });
});
