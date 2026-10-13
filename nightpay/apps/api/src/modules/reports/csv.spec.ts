import { describe, it, expect } from 'vitest';
import { code, date, money, text, time, toCsv } from './csv';
import { parseReportPeriod, periodSlug } from './report-period';

describe('CSV para Excel en español', () => {
  it('BOM, separador ";" y fin de línea CRLF', () => {
    expect(toCsv([['a', 'b'], ['1', '2']])).toBe('\uFEFFa;b\r\n1;2\r\n');
  });

  it('entrecomilla lo que lleva ";", comillas o saltos de línea', () => {
    expect(toCsv([[text('Cliente; dice "no"'), text('dos\nlíneas')]])).toBe(
      '\uFEFF"Cliente; dice ""no""";"dos\nlíneas"\r\n',
    );
  });

  it('texto escrito por personas que empieza por = + - @ no se ejecuta como fórmula', () => {
    const csv = toCsv([[text('=HYPERLINK("http://x")'), text('+34'), text('-1'), text('@SUM(A1)'), text('Ana')]]);
    expect(csv).toBe('\uFEFF"\'=HYPERLINK(""http://x"")";\'+34;\'-1;\'@SUM(A1);Ana\r\n');
  });

  it('códigos y referencias del banco no se convierten en números en Excel', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(toCsv([[code('1E5'), code('047215'), code(null)]])).toBe(`${bom}"=""1E5""";"=""047215""";\r\n`);
    // Con otros caracteres, como texto protegido.
    expect(toCsv([[code('=1+1')]])).toBe(`${bom}'=1+1\r\n`);
  });

  it('importes con coma decimal; los negativos siguen siendo números', () => {
    expect(money(123_456)).toBe('1234,56');
    expect(money(5)).toBe('0,05');
    expect(money(-500)).toBe('-5,00');
    expect(toCsv([[money(-500)]])).toBe('\uFEFF-5,00\r\n');
  });

  it('fecha y hora en hora de Madrid', () => {
    const d = new Date('2026-10-13T22:41:00Z');
    expect(date(d)).toBe('14/10/2026');
    expect(time(d)).toBe('00:41');
    expect(date(null)).toBe('');
  });
});

describe('periodo del informe', () => {
  it('un mes en hora de Madrid, ambos días incluidos', () => {
    const r = parseReportPeriod('2026-10-01', '2026-10-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.period.from.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(r.period.to.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(periodSlug(r.period)).toBe('2026-10');
  });

  it('periodo suelto → nombre con las dos fechas', () => {
    const r = parseReportPeriod('2026-10-01', '2026-10-15');
    expect(r.ok && periodSlug(r.period)).toBe('2026-10-01_2026-10-15');
  });

  it('rechaza fechas mal escritas, inexistentes, al revés o de más de un año', () => {
    expect(parseReportPeriod('2026-13-01', '2026-13-02').ok).toBe(false);
    expect(parseReportPeriod('2026-02-30', '2026-03-01').ok).toBe(false);
    expect(parseReportPeriod('01/10/2026', '2026-10-31').ok).toBe(false);
    expect(parseReportPeriod('2026-10-31', '2026-10-01').ok).toBe(false);
    expect(parseReportPeriod('2025-01-01', '2026-06-30').ok).toBe(false);
    expect(parseReportPeriod('2026-01-01', '2026-12-31').ok).toBe(true);
  });
});
