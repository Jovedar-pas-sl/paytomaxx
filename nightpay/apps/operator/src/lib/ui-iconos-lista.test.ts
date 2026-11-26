import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IosInstallSteps } from '@nightpay/ui';
import { TabBar } from '../components/TabBar';

// «Piezas I», parte B (idea 58): UN juego de iconos. Fuera de Icon.tsx no queda
// ningún <svg> dibujado a mano, salvo los que tienen su entrega («Queda») y los
// que no son iconos (los QR, la marca de PAGADO y NO PAGADO, los iconos de la
// carta…). Un <svg> nuevo en cualquier otro sitio hace fallar esta prueba: se
// dibuja una línea más en ICON_PATHS y se pinta con <Icon>.

const REPO = join(__dirname, '..', '..', '..', '..');
const read = (...rel: string[]): string => readFileSync(join(REPO, ...rel), 'utf8').replace(/\r\n/g, '\n');
const ROOTS = ['apps/admin/src', 'apps/operator/src', 'apps/tpv/src', 'apps/web-client/src', 'packages/ui/src'];

/** Fichero → cuántos <svg> puede tener. */
const ALLOWED: Record<string, number> = {
  'packages/ui/src/components/Icon.tsx': 1,
  // Queda, con su entrega.
  'apps/admin/src/components/NightCajaBlock.tsx': 1, // → 10
  'apps/admin/src/components/NightCloseScreen.tsx': 4, // → 10
  'apps/operator/src/components/MyCobros.tsx': 1, // → 6
  'apps/operator/src/components/guia/CuentaBasica.tsx': 1, // → 5
  'apps/operator/src/components/guia/Guia.tsx': 1, // → 5
  'apps/operator/src/components/reception/desk/desk-parts.tsx': 1, // → 8
  'apps/operator/src/components/pantalla/PantallaCliente.tsx': 2, // → 12
  'apps/web-client/src/app/_portada/icons.tsx': 1, // → 12
  // No son iconos: se quedan siempre.
  'apps/admin/src/components/superadmin/QrCode.tsx': 1,
  'apps/operator/src/components/cobrar/CobroQr.tsx': 1,
  'apps/operator/src/components/cobrar/MiQr.tsx': 1,
  'apps/operator/src/components/reception/desk/QrBox.tsx': 1,
  'apps/tpv/src/components/ActivePayment.tsx': 1,
  'apps/admin/src/components/fichas/MethodMark.tsx': 1,
  'packages/ui/src/components/CartaIcon.tsx': 1,
  'packages/ui/src/components/DoneMark.tsx': 1,
  'packages/ui/src/components/PaymentOutcome.tsx': 2,
};

/** El código de las apps y de ui (sin pruebas, que citan «<svg» en sus textos). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '.next' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('un solo juego de iconos', () => {
  it('<svg> solo en Icon.tsx y en la lista exacta de lo que queda y de lo que no es un icono', () => {
    const found: Record<string, number> = {};
    for (const root of ROOTS) {
      for (const file of sources(join(REPO, root))) {
        const count = (readFileSync(file, 'utf8').match(/<svg\b/g) ?? []).length;
        if (count > 0) found[relative(REPO, file).replace(/\\/g, '/')] = count;
      }
    }
    expect(found).toEqual(ALLOWED);
  });

  it('fuera los juegos de Cobrar y de OxioParty: nadie los importa', () => {
    expect(existsSync(join(REPO, 'apps/operator/src/components/cobrar/icons.tsx'))).toBe(false);
    expect(existsSync(join(REPO, 'apps/operator/src/components/party/party-icons.tsx'))).toBe(false);
    for (const file of sources(join(REPO, 'apps/operator/src'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from '\.\/icons'|from '\.\/party-icons'|cobrar\/icons'|party\/party-icons'/);
    }
  });
});

describe('las barras de abajo, a 24 y la pestaña elegida más gruesa (por CSS)', () => {
  it('la del personal: cada icono a 24 con 2 px a la vista', () => {
    const html = renderToStaticMarkup(createElement(TabBar, { tabs: ['home', 'payments', 'earnings'], active: 'home', onSelect: () => undefined }));
    const svgs = html.match(/<svg [^>]*>/g) ?? [];
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) {
      expect(svg).toContain('width="24" height="24"');
      expect(svg).toContain('stroke-width="2"');
    }
    expect(html.match(/class="np-staff-tab"/g)).toHaveLength(3);
    expect(rule(read('packages/ui/src/staff.css'), ".np-staff-tab[aria-current='page'] svg")).toContain('stroke-width: 2.4');
  });

  it('la del panel: la pieza Icon a 24 y la elegida con 2,4', () => {
    const nav = read('apps/admin/src/components/BottomNav.tsx');
    expect(nav).toMatch(/<Icon name=\{NAV_ICON\[item\.key\]\} \/>/);
    expect(rule(read('apps/admin/src/styles/panel-nav.css'), ".np-bottomnav-item[aria-current='page'] svg")).toContain('stroke-width: 2.4');
  });
});

describe('sueltos que ahora son la pieza', () => {
  it('los pasos del iPhone: el icono de Compartir no se lee; su descripción va aparte para el lector', () => {
    const html = renderToStaticMarkup(createElement(IosInstallSteps));
    expect(html).toContain('width="20" height="20"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).toContain('<span class="np-sr-only">(el cuadrado con la flecha hacia arriba)</span>');
  });

  it('la ✕ de las ventanas sigue siendo .np-modal-close, con la pieza a 20 dentro', () => {
    const modal = read('packages/ui/src/components/Modal.tsx');
    expect(modal).toContain('className="np-modal-close"');
    expect(modal).toContain('<Icon name="close" size={20} />');
  });
});
