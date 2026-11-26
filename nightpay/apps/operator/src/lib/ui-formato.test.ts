import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dayInZone, formatBps, formatDateTime, formatPercent, formatRelative } from '@nightpay/ui';

// «Piezas I» (idea 56): UN «hace…» y UN «%» para todas las apps. Las horas
// van por noches (de 08:00 a 08:00, como «Desde hoy 23:40» de las fichas): a
// las 3 de la madrugada, lo de las 23:00 es «hoy».

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NBSP = '\u00a0';

describe('formatRelative', () => {
  // Lunes 16 de noviembre de 2026, 21:40 en Madrid.
  const now = new Date('2026-11-16T21:40:00+01:00');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it('menos de un minuto, o en el futuro (un reloj atrasado): «ahora»', () => {
    expect(formatRelative(ago(0), now)).toBe('ahora');
    expect(formatRelative(ago(59_000), now)).toBe('ahora');
    expect(formatRelative(ago(-5 * MIN), now)).toBe('ahora');
  });

  it('menos de una hora: «hace 12 min»', () => {
    expect(formatRelative(ago(MIN), now)).toBe('hace 1 min');
    expect(formatRelative(ago(12 * MIN), now)).toBe('hace 12 min');
    expect(formatRelative(ago(HOUR - 1000), now)).toBe('hace 59 min');
  });

  it('menos de 12 horas: «hace 3 h», hacia abajo', () => {
    expect(formatRelative(ago(HOUR), now)).toBe('hace 1 h');
    expect(formatRelative(ago(3 * HOUR + 59 * MIN), now)).toBe('hace 3 h');
    expect(formatRelative(ago(12 * HOUR - 1000), now)).toBe('hace 11 h');
  });

  it('más de 12 horas, la misma noche: «hoy, 09:10»', () => {
    expect(formatRelative('2026-11-16T09:10:00+01:00', now)).toBe('hoy, 09:10');
  });

  it('la noche anterior: «ayer, 21:30»', () => {
    expect(formatRelative('2026-11-15T21:30:00+01:00', now)).toBe('ayer, 21:30');
    // Las 03:00 del lunes son de la noche del domingo.
    expect(formatRelative('2026-11-16T03:00:00+01:00', now)).toBe('ayer, 03:00');
  });

  it('más atrás: el día y la hora; de otro año, con el año', () => {
    expect(formatRelative('2026-11-14T21:30:00+01:00', now)).toBe('14 nov, 21:30');
    expect(formatRelative('2026-11-05T08:05:00+01:00', now)).toBe('5 nov, 08:05');
    expect(formatRelative('2025-11-15T21:30:00+01:00', now)).toBe('15 nov 2025, 21:30');
  });

  it('de madrugada: a las 03:10, las 12:00 de antes son «hoy, 12:00»', () => {
    const late = new Date('2026-11-17T03:10:00+01:00');
    expect(formatRelative('2026-11-16T12:00:00+01:00', late)).toBe('hoy, 12:00');
    expect(formatRelative('2026-11-16T07:00:00+01:00', late)).toBe('ayer, 07:00');
    expect(formatRelative('2026-11-17T02:50:00+01:00', late)).toBe('hace 20 min');
    expect(formatRelative('2026-11-16T23:00:00+01:00', late)).toBe('hace 4 h');
  });

  it('acepta un Date, va en la zona del local y lo ilegible sale como raya', () => {
    expect(formatRelative(new Date('2026-11-15T21:30:00+01:00'), now)).toBe('ayer, 21:30');
    expect(formatRelative('2026-11-14T21:30:00+01:00', now, 'America/Mexico_City')).toBe('14 nov, 14:30');
    expect(formatRelative('no-es-fecha', now)).toBe('—');
  });

  it('24 horas y el mes sin punto', () => {
    expect(formatRelative('2026-09-05T15:00:00+02:00', now)).toBe('5 sept, 15:00');
    expect(formatRelative('2026-11-14T00:05:00+01:00', now)).toBe('14 nov, 00:05');
  });
});

describe('formatPercent y formatBps', () => {
  it('con espacio duro antes del «%» y sin «,0»', () => {
    expect(formatPercent(37.5)).toBe(`37,5${NBSP}%`);
    expect(formatPercent(30)).toBe(`30${NBSP}%`);
    expect(formatPercent(0)).toBe(`0${NBSP}%`);
  });

  it('un decimal como mucho, salvo que se pidan otros', () => {
    expect(formatPercent(12.34)).toBe(`12,3${NBSP}%`);
    expect(formatPercent(12.34, 2)).toBe(`12,34${NBSP}%`);
    expect(formatPercent(66.6, 0)).toBe(`67${NBSP}%`);
  });

  it('formatBps: puntos básicos, sin redondear a entero (hasta dos decimales)', () => {
    expect(formatBps(3000)).toBe(`30${NBSP}%`);
    expect(formatBps(3750)).toBe(`37,5${NBSP}%`);
    expect(formatBps(1025)).toBe(`10,25${NBSP}%`);
  });
});

describe('las fechas del panel suben a @nightpay/ui', () => {
  it('formatDateTime y dayInZone, los de siempre', () => {
    const iso = '2026-10-15T19:30:05Z';
    expect(formatDateTime(iso, 'Europe/Madrid', 'short')).toBe('15 oct, 21:30');
    expect(formatDateTime(iso, 'Marte/Base', 'time')).toBe('21:30');
    expect(formatDateTime('no-es-fecha')).toBe('—');
    expect(dayInZone(new Date('2026-10-15T22:30:00Z'), 'Europe/Madrid')).toBe('2026-10-16');
  });

  it('el panel los reexporta (no hay dos copias)', () => {
    const dates = read('../../../admin/src/lib/dates.ts');
    expect(dates).toMatch(/export \{[^}]*\bdayInZone\b[^}]*\} from '@nightpay\/ui';/);
    expect(dates).toMatch(/export \{[^}]*\bformatDateTime\b[^}]*\} from '@nightpay\/ui';/);
    expect(dates).not.toMatch(/export function (formatDateTime|dayInZone)\b/);
  });
});

describe('los cuatro «hace» y los «%» a mano usan las piezas', () => {
  it('ya no hay un «hace» propio en aprobaciones, POS pendientes, datáfono ni recepción', () => {
    const approvals = read('../../../admin/src/lib/approvals.ts');
    expect(approvals).not.toMatch(/function timeAgo/);
    expect(approvals).toContain('formatRelative(');
    const pos = read('../components/PendingPos.tsx');
    expect(pos).not.toMatch(/function timeAgo|'ahora mismo'/);
    expect(pos).toContain('formatRelative(');
    const pax = read('../components/pax/PaxScreen.tsx');
    expect(pax).not.toMatch(/minutesAgo|un momento/);
    expect(pax).toContain('formatRelative(');
    const desk = read('./reception-desk.ts');
    expect(desk).not.toMatch(/hace un momento|`hace \$\{/);
    expect(desk).toContain('formatRelative(');
  });

  it('«Desde hoy 23:40» de las fichas se queda (por noches, con su prueba)', () => {
    expect(read('../../../admin/src/lib/ficha-sheets.ts')).toContain('export function sinceLabel(');
  });

  it('un solo formatBps: el del panel y el del personal son el de ui', () => {
    expect(read('../../../admin/src/lib/commission.ts')).toMatch(/export \{ formatBps \} from '@nightpay\/ui';/);
    expect(read('../../../admin/src/lib/commission.ts')).not.toMatch(/function formatPercent/);
    expect(read('./money.ts')).toMatch(/export \{ formatBps \} from '@nightpay\/ui';/);
    expect(read('./money.ts')).not.toMatch(/Intl\.NumberFormat/);
  });

  it('ningún «%» pegado a mano donde el encargo lo migra', () => {
    const byHand = /toLocaleString\('es-ES', \{ maximumFractionDigits: \d \}\)\} %|\} %<|\} % ·|\* 100\)\} %/;
    for (const rel of [
      '../../../admin/src/lib/ficha-sheets.ts',
      '../../../admin/src/lib/home-topup.ts',
      '../../../admin/src/lib/party-live.ts',
      '../components/cobrar/PinScreen.tsx',
      './pantalla-state.ts',
    ]) {
      expect(read(rel), rel).not.toMatch(byHand);
    }
  });
});
