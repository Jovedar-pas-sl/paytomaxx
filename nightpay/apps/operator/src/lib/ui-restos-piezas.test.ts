import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// «Piezas I», lo que se arregla de paso (ideas 53 y 60): ni «EUR» ni importes
// pegados a mano en el cobro abierto, los POS pendientes y los pagos del
// panel; ni emojis ni «✓» escrita como letra donde el encargo lo pide; la ✕
// de las ventanas, de 44 px. Y pieces.css, que ve bien un Chrome 64.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
/** Sin los comentarios: lo que cuenta es lo que se pinta, no lo que se explica. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const ACTIVE = read('../components/ActivePayment.tsx');
const PENDING = read('../components/PendingPos.tsx');
const PAYMENTS = read('../../../admin/src/components/PaymentsPanel.tsx');
const ONBOARDING = read('../app/onboarding/[token]/SelfOnboardingClient.tsx');
const UI = '../../../../packages/ui/src/';
const STYLES = read(`${UI}styles.css`);
const PIECES = read(`${UI}pieces.css`);

/** El cuerpo de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no está ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('importes: «€» y la regla común, nunca «EUR» ni cuentas a mano', () => {
  for (const [name, text] of [
    ['ActivePayment', ACTIVE],
    ['PendingPos', PENDING],
    ['PaymentsPanel', PAYMENTS],
  ] as const) {
    it(`${name}: sin formatEurAmount, sin «EUR» suelto y sin toFixed pegado al «€»`, () => {
      expect(text).not.toContain('formatEurAmount');
      expect(text).not.toContain('>EUR<');
      expect(text).not.toContain(".toFixed(2).replace('.', ',')} €");
    });
  }

  it('formatEurAmount ya no existe (era solo para poner «EUR» aparte)', () => {
    expect(read('./money.ts')).not.toContain('formatEurAmount');
  });

  it('el cobro abierto y los POS pendientes escriben el importe con formatEur', () => {
    expect(ACTIVE).toContain('{formatEur(isPos ? chargeWithFeeCents(payment) : payment.amountCents)}');
    expect(PENDING).toContain('{formatEur(p.amountCents)}');
    expect(PENDING).toContain('{formatEur(payment.amountCents)}');
    expect(PAYMENTS).toContain('label: `Cobro de ${formatEur(charged)}`');
  });

  it('la línea deletreada para el IM30 sigue con su toFixed(2), cifra a cifra', () => {
    const at = PENDING.indexOf('<p style={amountDigitsStyle}>');
    expect(at).toBeGreaterThan(-1);
    const line = PENDING.slice(at, PENDING.indexOf('</p>', at));
    expect(line).toContain('(payment.amountCents / 100)');
    expect(line).toContain('.toFixed(2)');
    expect(line).toContain(".map((c) => (c === '.' ? '·' : c))");
  });

  it('el gráfico por horas usa el formato corto de formatMoney («3,1 mil €»)', () => {
    const live = read('../../../admin/src/lib/party-live.ts');
    expect(live).toContain('short: true');
    expect(live).not.toMatch(/toFixed\(1\)\.replace\('\.', ','\)\} k/);
  });

  it('Importe en «Esta noche» del panel (Pagado en grande en el Resumen, el resto sin `size`), del personal y en «Mis cobros»', () => {
    const strip = read('../../../admin/src/components/TonightStrip.tsx');
    // Entrega 9 B: «Pagado esta noche» del Resumen va en tamaño héroe y rueda; en la franja entera, sin tamaño.
    expect(strip).toContain(`<Importe cents={night.chargedCents} size={full ? undefined : 'hero'} decimals="always" rolling />`);
    expect(strip.match(/<Importe[^>]*size=/g)).toHaveLength(1);
    expect(strip.match(/<Importe cents=\{[a-zA-Z.]+\} decimals="always"( rolling)? \/>/g)).toHaveLength(2);
    const card = read('../components/TonightCard.tsx');
    expect(card).toContain('<Importe cents={cents} rolling />');
    const cobros = read('../components/MyCobros.tsx');
    expect(cobros).toContain('<Importe cents={t.salesCents} rolling />');
    expect(cobros).toContain('<Importe cents={r.amountCents} />');
    // Conservan su clase y su tachado.
    expect(cobros).toContain('<b className={`np-num ${styles.nightTotal}`}>');
    expect(cobros).toMatch(/<b className=\{`np-num \$\{styles\.amount\}`\} data-gone=/);
  });
});

describe('ni emojis ni «✓» como letra', () => {
  // U+FE0F (el selector que convierte un signo en emoji) va aparte: dentro de una clase, ESLint lo da por error.
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]|\u{FE0F}/u;

  it('el alta de la compañera y los POS pendientes, sin emojis (queda la palabra)', () => {
    expect(ONBOARDING).not.toMatch(EMOJI);
    expect(PENDING).not.toMatch(EMOJI);
    for (const word of ['No he empezado', 'Registrada, falta KYC', 'KYC enviado, esperando', 'KYC aprobado, todo OK', 'KYC rechazado']) {
      expect(ONBOARDING).toContain(`'${word}'`);
    }
    expect(PENDING).toContain('<Icon name="alert" size={20} className="np-icon-lead" />');
    expect(PENDING).toContain('Teclea EXACTAMENTE en el datáfono');
  });

  it('el cobro abierto, los POS pendientes y los avisos de «Mi perfil»: el ✓ es el icono', () => {
    for (const [name, text] of [
      ['ActivePayment', ACTIVE],
      ['PendingPos', PENDING],
      ['profile-parts', read(`${UI}components/profile-parts.tsx`)],
    ] as const) {
      expect(code(text), name).not.toContain('✓');
      expect(text, name).toContain('<Icon name="check"');
    }
    expect(ACTIVE).toContain('Copiado');
    expect(ACTIVE).toContain('Pagado — nuevo');
    expect(PENDING).toContain('Ningún cobro esperando el datáfono');
    expect(PENDING).toContain('Confirmar pagado en el datáfono');
  });

  it('el icono delante de su palabra va centrado con la letra y no agranda la línea', () => {
    const lead = rule(PIECES, '.np-icon-lead');
    expect(lead).toContain('vertical-align: middle');
    expect(lead).toContain('margin: -0.125rem 0.375rem -0.125rem 0');
  });
});

describe('retoques', () => {
  it('la ✕ de las ventanas mide 44 px (2.75rem)', () => {
    const close = rule(STYLES, '.np-modal-close');
    expect(close).toContain('width: 2.75rem');
    expect(close).toContain('height: 2.75rem');
  });
});

describe('pieces.css', () => {
  it('se importa arriba en styles.css, junto a los otros tres', () => {
    expect(STYLES).toMatch(/@import '\.\/staff\.css';\n@import '\.\/tour\.css';\n@import '\.\/ticket\.css';\n@import '\.\/pieces\.css';/);
  });

  it('lo ve bien un Chrome 64: sin gap, inset, :has(), :where(), :is() ni aspect-ratio', () => {
    const css = code(PIECES);
    expect(css).not.toMatch(/(^|[\s;{])(gap|row-gap|column-gap|inset|aspect-ratio)\s*:/m);
    expect(css).not.toMatch(/:has\(|:where\(|:is\(/);
    // rgb() con espacios es de Chrome 65: las transparencias, con comas.
    expect(css).not.toMatch(/rgba?\(\d+ \d+/);
    expect(css).not.toMatch(/color-mix\(|oklch\(/);
  });

  it('min(), max() y clamp() solo dentro de @supports', () => {
    const css = code(PIECES);
    // Se quitan los bloques @supports enteros (hasta su llave de cierre en la columna 0).
    const outside = css.replace(/@supports[^{]*\{[\s\S]*?\n\}/g, '');
    expect(outside).not.toMatch(/\b(min|max|clamp)\(/);
    expect(css).toMatch(/@supports \(font-size: clamp\(1rem, 1vw, 2rem\)\)/);
  });

  it('las piezas se exportan desde @nightpay/ui', () => {
    const index = read(`${UI}index.ts`);
    for (const name of ['Importe', 'RollingNumber', 'EmptyState', 'Skeleton', 'Icon', 'IconButton', 'ICON_PATHS', 'Etiqueta', 'Tag', 'TONE_COLORS', 'formatRelative', 'formatPercent', 'formatBps', 'formatDateTime', 'dayInZone']) {
      expect(index, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
