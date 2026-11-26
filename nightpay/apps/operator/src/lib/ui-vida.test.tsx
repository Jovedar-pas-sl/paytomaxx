import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EarningsDetail } from '../components/EarningsDetail';
import { PayoutsReceived } from '../components/PayoutsReceived';
import { TabBar } from '../components/TabBar';
import type { MyNight } from './api';
import { moneySummary } from './earnings-view';
import { tabDirection } from './tab-url';

// Entrega 4, parte A — «App del personal: vida»: cifras que ruedan (idea 5),
// la entrada con ambiente (6), listas vacías (7), siluetas de carga (8) y el
// cambio de pestaña (10). Casi todo se comprueba leyendo el código y el CSS
// como texto; lo que se pinta, con react-dom/server (solo el marcado).

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const UI = '../../../../packages/ui/src/';
const STAFF = strip(read(`${UI}staff.css`));
const noop = () => undefined;

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

/** Todo lo que va dentro de los bloques de «reducir movimiento». */
function reducedMotion(css: string): string {
  return css
    .split('@media (prefers-reduced-motion: reduce)')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('\n}\n') + 1))
    .join('\n');
}

describe('(a) el CSS de la entrada y del cambio de pestaña (staff.css)', () => {
  it('la entrada: la trama de la marca y un resplandor lima suave, dibujo fijo', () => {
    const login = rule(STAFF, '.np-login');
    expect(login).toContain('background-color: var(--np-bg)');
    expect(login).toContain('var(--np-bits-brand)');
    const limes = Array.from(login.matchAll(/rgba\(199, 211, 1, ([\d.]+)\)/g)).map((m) => Number(m[1]));
    expect(limes.length).toBeGreaterThan(0);
    for (const alpha of limes) expect(alpha).toBeLessThanOrEqual(0.16);
    // Chrome 64: colores con comas.
    expect(login).not.toMatch(/rgba?\(\d+ \d+/);
    expect(login).not.toMatch(/blur\(|backdrop-filter|animation/);
  });

  it('en «sala», en claro y en «Modo día», fondo liso', () => {
    expect(STAFF).toMatch(
      /html\[data-contrast='sala'\] \.np-login,\s*html\[data-theme='light'\] \.np-login,\s*html\[data-theme='day'\] \.np-login \{\s*background-image: none;/,
    );
  });

  it('la marca de la pestaña se desliza (solo transform) y su raya es lima', () => {
    const mark = rule(STAFF, '.np-tabmark');
    expect(mark).toMatch(/transition: transform 250ms cubic-bezier\(0\.2, 0, 0, 1\)/);
    expect(mark).toContain('width: calc(100% / var(--n))');
    expect(mark).toContain('transform: translateX(calc(100% * var(--i)))');
    expect(mark).not.toContain('inset');
    expect(rule(STAFF, '.np-tabmark::after')).toContain('background: var(--np-accent)');
  });

  it('el contenido entra con opacity y transform; Inicio y Recepción, solo opacity', () => {
    const at = STAFF.indexOf('@keyframes np-tab-in {');
    expect(at).toBeGreaterThan(0);
    const keyframes = STAFF.slice(at, STAFF.indexOf('\n}\n', at));
    const props = Array.from(keyframes.matchAll(/([a-z-]+):/g)).map((m) => m[1]);
    expect(new Set(props)).toEqual(new Set(['opacity', 'transform']));
    expect(rule(STAFF, '.np-tab-in')).toMatch(/animation: np-tab-in 250ms cubic-bezier\(0\.2, 0, 0, 1\) backwards/);

    const fadeAt = STAFF.indexOf('@keyframes np-tab-fade {');
    const fade = STAFF.slice(fadeAt, STAFF.indexOf('\n}\n', fadeAt));
    expect(new Set(Array.from(fade.matchAll(/([a-z-]+):/g)).map((m) => m[1]))).toEqual(new Set(['opacity']));
    expect(rule(STAFF, '.np-tab-fade')).toMatch(/animation: np-tab-fade 250ms cubic-bezier\(0\.2, 0, 0, 1\) backwards/);
    expect(STAFF).not.toMatch(/np-tab-(in|fade)[^;]*forwards/);
  });

  it('con «reducir movimiento», las tres quietas', () => {
    const reduce = reducedMotion(STAFF);
    expect(reduce).toMatch(/\.np-tab-in,\s*\.np-tab-fade \{\s*animation: none;/);
    expect(reduce).toMatch(/\.np-tabmark \{\s*transition: none;/);
  });
});

describe('(b) la entrada con ambiente', () => {
  it.each(['../app/page.tsx', '../app/accept-invite/page.tsx'])('los dos <main> de %s llevan np-login', (file) => {
    const src = strip(read(file));
    const mains = src.match(/<main[^>]*>/g) ?? [];
    expect(mains).toHaveLength(2);
    for (const main of mains) expect(main).toContain('className="np-screen np-login"');
  });

  it('las dos esperas, sin texto a la vista: «Cargando…» solo para el lector y aria-busy', () => {
    for (const file of ['../app/page.tsx', '../app/accept-invite/page.tsx']) {
      const src = strip(read(file));
      expect(src, file).toMatch(/<main className="np-screen np-login"[^>]*aria-busy="true"[^>]*>\s*<span className="np-sr-only" role="status">Cargando…<\/span>/);
    }
  });

  it('pregunta 2: también el panel y el TPV', () => {
    for (const file of ['../../../admin/src/app/page.tsx', '../../../tpv/src/app/page.tsx']) {
      const mains = strip(read(file)).match(/<main\s[^>]*>/g) ?? [];
      expect(mains, file).toHaveLength(2);
      for (const main of mains) expect(main, file).toMatch(/className="(np-screen )?np-login"/);
    }
  });
});

describe('(c) la barra de abajo: una sola marca', () => {
  const bar = (active: 'home' | 'payments' | 'earnings') =>
    renderToStaticMarkup(<TabBar tabs={['home', 'payments', 'earnings']} active={active} onSelect={noop} />);

  it('una np-tabmark, decorativa, con su sitio (--i) y cuántas pestañas hay (--n)', () => {
    const html = bar('payments');
    expect(html.match(/np-tabmark/g)).toHaveLength(1);
    const mark = /<span[^>]*class="np-tabmark"[^>]*>/.exec(html)![0];
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).toContain('--i:1');
    expect(mark).toContain('--n:3');
    expect(bar('home')).toContain('--i:0');
  });

  it('sin pestaña elegida entre las suyas, no se pinta', () => {
    const html = renderToStaticMarkup(<TabBar tabs={['home', 'payments']} active="earnings" onSelect={noop} />);
    expect(html).not.toContain('np-tabmark');
  });

  it('va en el <nav>, con su key (si las pestañas cambian al cargar, no se desliza)', () => {
    const src = read('../components/TabBar.tsx');
    expect(src).toContain("key={tabs.join()}");
    expect(src.slice(src.indexOf('function TabBtn'))).not.toContain('np-tabmark');
  });
});

describe('(d) hacia dónde entra la pestaña', () => {
  const tabs = ['home', 'payments', 'earnings'] as const;

  it('1 a la derecha, −1 a la izquierda, 0 la misma (o una que no está)', () => {
    expect(tabDirection(tabs, 'home', 'earnings')).toBe(1);
    expect(tabDirection(tabs, 'earnings', 'payments')).toBe(-1);
    expect(tabDirection(tabs, 'payments', 'payments')).toBe(0);
    expect(tabDirection(tabs, 'pos', 'home')).toBe(0);
  });

  it('Dashboard no anima con un cobro abierto ni antes del primer toque en la barra', () => {
    const src = read('../components/Dashboard.tsx');
    expect(src).toContain('const switched = useRef(false)');
    expect(src).toContain('tabDirection(tabs, tab, next)');
    expect(src).toMatch(/switched\.current && !charges\.open/);
    expect(src).toContain("'np-tab-in'");
    expect(src).toContain("'np-tab-fade'");
  });
});

describe('(e) las cifras que ruedan (y las que no)', () => {
  it('el total de «Mis cobros» y «Esta noche»: Importe con rolling', () => {
    expect(read('../components/MyCobros.tsx')).toContain('<Importe cents={t.salesCents} rolling />');
    expect(read('../components/TonightCard.tsx')).toContain('<Importe cents={cents} rolling />');
  });

  it('«Próximo pago» y «Esta noche llevas»: RollingNumber con la cifra ya escrita', () => {
    expect(read('../components/Earnings.tsx')).toContain('<RollingNumber text={formatEur(nextPayoutCents, { compact: true })} />');
    expect(read('../components/cobrar/SinCobrar.tsx')).toContain('<RollingNumber text={formatEur(night.netCents, { compact: true })} />');
  });

  it('PAGADO, CARGADO, el cobro abierto y «Servicio de Nerea» no ruedan', () => {
    for (const file of [
      '../components/reception/desk/DeskLoaded.tsx',
      '../components/StaffOutcome.tsx',
      '../components/cobrar/Esperando.tsx',
      '../components/cobrar/ServicioDe.tsx',
      `${UI}components/PaymentOutcome.tsx`,
    ]) {
      const src = strip(read(file));
      expect(src, file).not.toContain('RollingNumber');
      expect(src, file).not.toMatch(/\brolling\b/);
    }
  });

  it('la pieza sale tal cual la primera vez, se lee por su .np-sr-only (sin aria-label) y salta con «reducir movimiento»', () => {
    const piece = read(`${UI}components/RollingNumber.tsx`);
    expect(piece).toContain('<span className="np-sr-only">{text}</span>');
    expect(piece).not.toContain('aria-label');
    const pieces = read(`${UI}pieces.css`);
    const at = pieces.indexOf('.np-roll-col {');
    expect(pieces.slice(at, pieces.indexOf('}', at))).toMatch(/transition: transform/);
    // La regla general de styles.css deja las transiciones en nada.
    expect(reducedMotion(read(`${UI}styles.css`))).toMatch(/\*::after \{[^}]*transition-duration: 0\.01ms !important;/);
  });
});

describe('(f) listas vacías', () => {
  const OLD: Array<[file: string, old: string[]]> = [
    ['MyCobros.tsx', ['Aún no has hecho cobros.', 'No hay cobros en esas fechas.']],
    [
      'EarningsDetail.tsx',
      [
        'Aún no tienes cobros esta noche.',
        'Aún no tienes ganancias.',
        'No hay ganancias en esas fechas.',
        'No hay pagos en esas fechas.',
        'Aún no te han pagado nada desde la app.',
        'Nada pendiente de otras noches.',
        'Nada en espera.',
        'Nada pendiente de cuadrar.',
        'No tienes nada que descontar.',
      ],
    ],
    ['PayoutsReceived.tsx', ['Aún no te han pagado nada desde la app.']],
    ['PendingPos.tsx', ['No hay cobros POS pendientes.']],
    ['pax/PaxScreen.tsx', ['No hay cobros esperando.', 'Cuando una chica cree un cobro por datáfono, sale aquí.']],
    ['pax/PaxSaldoFlow.tsx', ['No hay cobros del saldo esperando.']],
    ['cobrar/ElegirChica.tsx', ['No hay chicas dadas de alta en el local.']],
    ['cobrar/Carta.tsx', ['No hay productos disponibles para tu puesto.']],
    ['party/Barra.tsx', ['Tu caseta aún no tiene carta: el organizador la pone en su panel.']],
    ['reception/CashVoids.tsx', ['No hay ninguna que anular.']],
    ['reception/PendingTopUps.tsx', ['No hay ninguna pendiente.']],
    ['reception/ReceptionIncidents.tsx', ['No hay ninguna.']],
    ['rrpp/RrppView.tsx', []],
    ['PasskeySheet.tsx', []],
  ];

  it.each(OLD)('%s usa EmptyState y ya no dice su frase vieja', (file, old) => {
    const src = strip(read(`../components/${file}`));
    expect(src).toMatch(/import \{[^}]*\bEmptyState\b[^}]*\} from '@nightpay\/ui'/);
    expect(src).toContain('<EmptyState');
    for (const phrase of old) expect(src).not.toContain(phrase);
  });

  it('las frases nuevas, cada una con su icono', () => {
    const has = (file: string, ...parts: string[]) => {
      const src = read(`../components/${file}`);
      for (const part of parts) expect(src, `${file}: ${part}`).toContain(part);
    };
    has('MyCobros.tsx', 'icon="receipt"', 'Aún no has cobrado', 'Aquí verás cada cobro y cómo se pagó.', 'Ningún cobro en esas fechas', 'Tus servicios los ves en Ganancias.');
    has(
      'EarningsDetail.tsx',
      'icon="chart"',
      'Aún no has ganado nada',
      'Cada cobro tuyo suma aquí tu parte.',
      'Nada ganado en esas fechas',
      'icon="bank"',
      'Aún no te han pagado por aquí',
      'Cuando el local te pague, saldrá aquí.',
      'Ningún pago en esas fechas',
      'icon="calendar" title="No te deben nada de otras noches"',
      'icon="clock" title="Nada en espera"',
      'icon="bank" title="Nada por comprobar con el banco"',
      'icon="wallet" title="Nada que descontarte"',
    );
    has('PendingPos.tsx', 'icon="pos"', 'Ningún cobro esperando el datáfono', 'Cuando alguien cree uno, saldrá aquí.');
    has('pax/PaxScreen.tsx', 'icon="pos"', 'Ningún cobro esperando', 'Se crean en la app del personal, en Inicio.');
    has('pax/PaxSaldoFlow.tsx', 'icon="pos"', 'Ningún cobro esperando', 'Se crean en la app del personal, en Inicio.');
    has('rrpp/RrppView.tsx', 'icon="ticket"', 'Aún no hay reservas con tu enlace para las próximas noches.', 'No hay reservas tuyas de las últimas noches.');
    has('cobrar/ElegirChica.tsx', 'icon="users"', 'Aún no hay compañeras en este local', 'Las da de alta el dueño o el encargado en el panel.');
    has('cobrar/Carta.tsx', 'icon="list"', 'Tu carta está vacía', 'Pide al dueño o al encargado que ponga productos para tu puesto en el panel.', "label: 'Actualizar carta'");
    has('party/Barra.tsx', 'icon="list"', 'Tu caseta aún no tiene carta', 'La pone el organizador en su panel.', "label: 'Actualizar carta'");
    has('reception/CashVoids.tsx', 'compact icon="cash" title="Ninguna recarga que anular"');
    has('reception/PendingTopUps.tsx', 'compact icon="clock" title="Ninguna recarga pendiente"');
    has('reception/ReceptionIncidents.tsx', 'compact icon="alert" title="Ninguna incidencia"');
    has('PasskeySheet.tsx', 'compact icon="lock" title="Aún no tienes ninguna llave."');
  });

  it('«Pagos recibidos»: sin pagos lo dice (compacto); cargando, la silueta con aria-busy', () => {
    const empty = renderToStaticMarkup(<PayoutsReceived payouts={[]} account={null} />);
    expect(empty).toContain('Aún no te han pagado por aquí');
    expect(empty).toContain('data-compact');
    expect(empty).not.toContain('aria-busy');
    const loading = renderToStaticMarkup(<PayoutsReceived payouts={null} account={undefined} />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('Aún no te han pagado');
  });

  describe('la compañera con la casilla «Las compañeras cobran desde su móvil» apagada', () => {
    const NIGHT: MyNight = {
      from: '2026-11-25T21:00:00.000Z',
      to: null,
      nightOpen: true,
      count: 0,
      chargedCents: 0,
      commissionCents: 5_400,
      tipsCents: 0,
      reversedCents: 0,
      netCents: 5_400,
    };
    const tonight = (cobraEncargado?: boolean) =>
      renderToStaticMarkup(
        <EarningsDetail
          kind="tonight"
          night={NIGHT}
          summary={moneySummary(NIGHT, null)}
          earnings={[]}
          info={null}
          holdDays={0}
          cobraEncargado={cobraEncargado}
          onBack={noop}
        />,
      );

    it('«Esta noche» vacía: «Aún no has cobrado esta noche»; apagada, «Aún no llevas nada esta noche»', () => {
      expect(tonight()).toContain('Aún no has cobrado esta noche');
      expect(tonight()).not.toContain('Aún no llevas nada esta noche');
      expect(tonight(true)).toContain('Aún no llevas nada esta noche');
      expect(tonight(true)).not.toContain('Aún no has cobrado esta noche');
    });

    it('«Cobros» vacío: «Hoy cobra el encargado», y «Cobrar ahora» solo con onCobrar', () => {
      const src = strip(read('../components/MyCobros.tsx'));
      expect(src).toContain('title="Hoy cobra el encargado"');
      expect(src.match(/Cobrar ahora/g)).toHaveLength(1);
      expect(src).toMatch(/action=\{onCobrar \? \{ label: 'Cobrar ahora', onClick: onCobrar, primary: true \} : undefined\}/);
      // Con la casilla apagada, el vacío no lleva botón.
      const off = src.slice(src.indexOf('title="Hoy cobra el encargado"'));
      expect(off.slice(0, off.indexOf('/>'))).not.toContain('action');
    });

    it('Dashboard lee la casilla (sin pedir nada más) y solo da «Cobrar ahora» a quien cobra', () => {
      const src = read('../components/Dashboard.tsx');
      expect(src).toContain('cobraElEncargado(');
      expect(src).toContain('useMySections()');
      expect(src).toMatch(/<MyCobros[^>]*cobraEncargado=\{cobraEncargado\}[^>]*onCobrar=\{/);
      expect(src).toMatch(/<Earnings[^>]*cobraEncargado=\{cobraEncargado\}/);
      // A una compañera, solo cuando ya se sabe su casilla.
      expect(src).toMatch(/user\.role === 'OPERATOR' && \(!mine\.loaded \|\| cobraEncargado\)/);
    });
  });
});

describe('(g) ningún «Cargando» a la vista', () => {
  function sources(dir: string, out: Array<{ file: string; text: string }> = []): Array<{ file: string; text: string }> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) sources(path, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: path, text: strip(readFileSync(path, 'utf8')) });
    }
    return out;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const all = [...sources(join(root, 'components')), ...sources(join(root, 'app'))];

  it('solo para el lector de pantalla (.np-sr-only), salvo «Cargando…» de meter el saldo en la ficha (CashConfirmStep)', () => {
    const hits: string[] = [];
    for (const { file, text } of all) {
      for (const line of text.split('\n')) {
        if (!line.includes('Cargando')) continue;
        if (line.includes('np-sr-only')) continue;
        if (/DeskSteps\.tsx$/.test(file) && line.includes("props.busy ? 'Cargando…'")) continue;
        hits.push(`${file}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('las siluetas compuestas llevan aria-busy y «Cargando…» para el lector', () => {
    const shapes = read('../components/loading-shapes.tsx');
    for (const name of ['SkelRows', 'SkelCard', 'SkelTiles', 'SkelLine']) expect(shapes).toContain(`export function ${name}(`);
    expect(shapes).toContain('aria-busy="true"');
    expect(shapes).toContain('<span className="np-sr-only" role="status">');
    // Chrome 64: sin gap de flex, inset, aspect-ratio, min() ni clamp().
    expect(strip(shapes)).not.toMatch(/\bgap:|inset:|aspectRatio|min\(|clamp\(/);
  });

  it('«Mi perfil» (también del panel): el círculo de la foto y dos líneas', () => {
    const profile = strip(read(`${UI}components/ProfileScreen.tsx`));
    expect(profile).not.toMatch(/>\s*Cargando tu perfil…\s*<\/p>/);
    expect(profile).toMatch(/<Skeleton width="7rem" height="7rem" round \/>/);
    expect(profile).toContain('aria-busy="true"');
  });

  it('un error nunca deja una silueta: «Esta noche» y «Deudas» distinguen cargar de fallar', () => {
    expect(read('../components/Earnings.tsx')).toContain('loading={night === null && !nightError}');
    expect(read('../components/Dashboard.tsx')).toContain('balanceLoading={own.balance === null && !own.error}');
    const detail = read('../components/EarningsDetail.tsx');
    expect(detail).toContain('{info === undefined ? <SkelRows /> : null}');
    expect(detail).toContain('{info === null ? ');
  });
});

describe('(h) restos de las entregas 2 y 3', () => {
  it('los errores de Inicio, «Mis cobros» y Ganancias son la franja (Banner), no una tarjeta', () => {
    for (const file of ['Dashboard.tsx', 'MyCobros.tsx', 'Earnings.tsx']) {
      const src = strip(read(`../components/${file}`));
      expect(src, file).not.toMatch(/<Card\s+role="alert"/);
      expect(src, file).toContain('<Banner tone="danger"');
    }
    expect(read('../components/MyCobros.tsx')).toContain("action={{ label: 'Reintentar', onClick: refresh }}");
  });

  it('«Atrás» de «Mi perfil» es el botón de icono', () => {
    expect(read('../components/ProfileSheet.tsx')).toContain('<IconButton icon="chevron-left" label="Atrás" onClick={onClose} />');
  });

  it('el «✓» ya no es una letra: va el icono delante', () => {
    for (const file of ['../components/FichaTapped.tsx', '../components/NewWalletCard.tsx', '../components/DeviceSheet.tsx', './prueba-lectura.ts']) {
      expect(strip(read(file)), file).not.toContain('✓');
    }
    for (const file of ['../components/FichaTapped.tsx', '../components/NewWalletCard.tsx', '../components/DeviceSheet.tsx']) {
      expect(read(file), file).toContain('<Icon name="check" size={20} className="np-icon-lead" />');
    }
  });

  it('las horas de Recepción, con formatRelative', () => {
    expect(read('./api-incidencias.ts')).toContain('formatRelative(');
    expect(read('../components/reception/CashVoids.tsx')).toContain('formatRelative(');
    expect(read('../components/reception/PendingTopUps.tsx')).toContain('formatRelative(row.since, new Date())');
  });
});
