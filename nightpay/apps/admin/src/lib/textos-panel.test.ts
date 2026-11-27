import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Entrega 10 A (idea 24 y 20): los textos del panel en español llano. Se leen
// los ficheros como texto y sin comentarios: solo cuenta lo que se ve.

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');

const TREASURY = read('../components/TreasuryPanel.tsx');
const OPERATORS = read('../components/OperatorsPanel.tsx');
const OPERATORS_API = read('./endpoints/operators.ts');
const PAYOUT = read('../components/PayoutConfirmModal.tsx');
const SECURITY = read('../components/settings/SecurityPanel.tsx');
const DASHBOARD = read('../components/Dashboard.tsx');
const CLOSE = read('../components/NightCloseScreen.tsx');
const CASH_STEP = read('../components/NightCashStep.tsx');
const TOURS = read('./tours.ts');
const CLOSE_RULES = read('../../../api/src/modules/nights/close-check-rules.ts');

describe('Pagos a compañeras (TreasuryPanel)', () => {
  it('ningún texto viejo', () => {
    for (const old of [
      'Cargando treasury',
      'Saldo pendiente a compañeras',
      'Reconciliación on-chain',
      'Reconciliar ahora',
      'Payouts por método',
      'Sin payouts todavía',
      'Estado de reconciliación',
      'No se pudo reconciliar',
      'on-chain',
    ]) {
      expect(TREASURY).not.toContain(old);
    }
  });

  it('los nuevos, exactos', () => {
    for (const text of [
      'Por pagar a compañeras',
      'Comprobar pagos en criptomoneda',
      'Mira en la red de cada criptomoneda si han llegado los pagos que aún no están comprobados.',
      'Comprobar ahora',
      'Comprobados ${',
      'No se pudo comprobar: ',
      'Pagos por forma de pago',
      'Aún no has pagado a nadie.',
      'Pagos comprobados',
      'Aún no has pagado a ninguna compañera. Cuando le pagues, aquí verás cuántos pagos están comprobados, cuáles esperan y cuáles no cuadran.',
    ]) {
      expect(TREASURY).toContain(text);
    }
    expect(TREASURY).toMatch(/Comprobados \$\{[^}]+\} de \$\{[^}]+\} pagos\./);
    expect(TREASURY).toContain('<Skel');
  });

  it('las cifras de USDT, solo con pagos en cripto; «Comprobar…», solo con USDT o USDC', () => {
    for (const method of ["'USDT_'", "'USDC_'", "'BINANCE_PAY_ID'", "'OKX_INTERNAL'", "'BYBIT_INTERNAL'"]) {
      expect(TREASURY).toContain(method);
    }
  });
});

describe('ni «Operadora» ni «operadoras»', () => {
  it('en Compañeras, su API, Seguridad y la cabecera', () => {
    for (const source of [OPERATORS, OPERATORS_API, SECURITY, DASHBOARD]) {
      expect(source).not.toMatch(/Operadora|operadoras/);
    }
  });

  it('Compañeras, con sus textos', () => {
    for (const text of [
      'Compañeras',
      'Nueva compañera',
      'Compañera creada.',
      'Aún no hay compañeras. Da de alta a la primera con «Nueva compañera».',
      'Por pagar',
    ]) {
      expect(OPERATORS).toContain(text);
    }
    expect(OPERATORS).not.toContain('+ Nueva');
    expect(OPERATORS).not.toContain('Saldo pendiente');
    expect(OPERATORS_API).toContain('No se pudieron cargar las compañeras');
    expect(SECURITY).toContain("OPERATOR: 'Compañera'");
    expect(SECURITY).toContain('useVenue()');
    expect(SECURITY).not.toContain('<code>{user.venueSlug}</code>');
  });
});

describe('Apuntar un pago (PayoutConfirmModal)', () => {
  it('sin «Receipt», sin «liquidación»', () => {
    expect(PAYOUT).not.toMatch(/Receipt URL|Receipt ID|receipt ID/);
    expect(PAYOUT).not.toMatch(/liquidación|Liquidación|liquidar/);
  });

  it('los textos nuevos', () => {
    for (const text of [
      'Por pagar',
      'N.º de la transferencia o del justificante',
      'Enlace al justificante (opcional)',
      'Al poner el sexto número se apunta el pago. Cada código vale una sola vez.',
      'Apuntar el pago',
    ]) {
      expect(PAYOUT).toContain(text);
    }
  });
});

describe('cerrar la noche, sin «congelar»', () => {
  it('ni «Congelar el Z» ni «congelad» en el cierre, los tutoriales y las reglas del API', () => {
    for (const source of [CLOSE, CASH_STEP, TOURS, CLOSE_RULES]) {
      expect(source).not.toContain('Congelar el Z');
      expect(source).not.toMatch(/congelad/i);
    }
    expect(CLOSE).not.toMatch(/congel/i);
  });

  it('los textos nuevos', () => {
    expect(CLOSE).toContain('Cerrar la noche');
    expect(CLOSE).toContain('Todo listo. Al cerrar, el informe Z y la caja de esta noche quedan fijos.');
    expect(CLOSE).toMatch(/Noche cerrada a las \{[^}]+\}\. El informe Z queda fijo\./);
    expect(CLOSE).not.toContain('Volver a Noches');
    expect(CASH_STEP).toContain('la diferencia queda fija en el Z');
    expect(TOURS).toMatch(/target: 'cierre-congelar', title: 'Cerrar la noche'/);
    expect(CLOSE_RULES).toContain("title: 'Informe Z'");
  });
});

describe('la cabecera del panel', () => {
  it('sin el correo ni el slug; con el cambio de local del súper-admin', () => {
    expect(DASHBOARD).not.toContain('user.email');
    expect(DASHBOARD).not.toContain('user.venueSlug');
    expect(DASHBOARD).not.toContain('ROLE_LABELS');
    expect(DASHBOARD).toContain('<VenueSwitcher');
    expect(DASHBOARD).toContain('Súper-admin');
  });
});
