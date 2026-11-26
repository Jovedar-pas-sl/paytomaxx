import { describe, expect, it } from 'vitest';
import type { CobroRow } from '@nightpay/contracts';
import { COBROS_CSV_HEADER, CSV_MAX_ROWS, cobrosCsv, collectCobros, csvFileName } from './cobros-csv';
import { FALLBACK_SECTIONS } from './money-map';

// «Descargar» de Cobros (idea 17): un CSV para Excel en español con las filas
// que ese rol ya ve. Sin reparto, móvil, IP ni más tarjeta que los 4 últimos.

const ctx = { tz: 'Europe/Madrid', sections: FALLBACK_SECTIONS };

const row = (over: Partial<CobroRow> = {}): CobroRow => ({
  kind: 'PAYMENT',
  id: '11111111-2222-4333-8444-555555555555',
  ref: 'C-0024',
  confirmationCode: '4EF',
  createdAt: '2026-11-14T01:14:00Z',
  amountCents: 4000,
  tipCents: 500,
  serviceFeeCents: 120,
  currency: 'EUR',
  status: 'AUTHORIZED',
  person: { id: 'o1', name: 'Marta', role: 'OPERATOR' } as CobroRow['person'],
  sections: [],
  isTopUp: true,
  method: 'CARD',
  methodLabel: 'Tarjeta ••4242',
  wallet: null,
  service: '2× Copa',
  invited: null,
  lines: [],
  payment: { providerTxId: '047215' } as CobroRow['payment'],
  ...over,
});
const lines = (csv: string) => csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');

describe('el CSV de Cobros', () => {
  it('la cabecera, exacta', () => {
    expect(COBROS_CSV_HEADER.join(';')).toBe(
      'Fecha;Hora;Referencia;Sección;Qué;Quién;Cómo pagó;Estado;Importe pagado;Propina;Comisión del servicio;Código;Ref. del banco',
    );
    expect(lines(cobrosCsv([], ctx))).toEqual([COBROS_CSV_HEADER.join(';')]);
  });

  it('una fila: hora del local, lo pagado con propina y comisión, y con BOM para Excel', () => {
    const csv = cobrosCsv([row()], ctx);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines(csv)[1]).toBe('14/11/2026;02:14;C-0024;Recarga de saldo;2× Copa;Marta;Tarjeta ••4242;Pagado;46,20;5,00;1,20;"=""4EF""";"=""047215"""');
  });

  it('lo escrito por personas no se ejecuta en Excel: `=HYPERLINK(...)` va con apóstrofo', () => {
    const csv = cobrosCsv([row({ service: '=HYPERLINK("http://x";"y")', person: { id: 'o2', name: '+Luis', role: 'MANAGER' } as CobroRow['person'] })], ctx);
    expect(lines(csv)[1]).toContain(`"'=HYPERLINK(""http://x"";""y"")"`);
    expect(lines(csv)[1]).toContain(";'+Luis;");
  });

  it('el código va como ="4EF": Excel no lo convierte en número ni le quita los ceros', () => {
    expect(lines(cobrosCsv([row({ confirmationCode: '1E5' })], ctx))[1]).toContain('"=""1E5"""');
    expect(lines(cobrosCsv([row({ confirmationCode: null, payment: null })], ctx))[1]!.endsWith(';46,20;5,00;1,20;;')).toBe(true);
  });

  it('una invitación va en «Qué»; sin nadie del local, «Desde casa»', () => {
    const line = lines(cobrosCsv([row({ person: null, fromHome: true, invited: { id: 'o3', name: 'Nerea', role: 'OPERATOR' } as CobroRow['person'] })], ctx))[1]!;
    expect(line).toContain(';2× Copa · Invitación a Nerea;Desde casa;');
  });

  it('nada que el panel no enseñe ya en la fila: ni el reparto ni el móvil ni la IP', () => {
    expect(COBROS_CSV_HEADER).toHaveLength(13);
    expect(COBROS_CSV_HEADER.join(' ')).not.toMatch(/reparto|móvil|IP|parte/i);
  });

  it('el archivo se llama por el día del local; el tope son 5.000 filas', () => {
    expect(csvFileName(new Date('2026-11-14T23:30:00Z'), 'Europe/Madrid')).toBe('cobros-2026-11-15.csv');
    expect(CSV_MAX_ROWS).toBe(5000);
  });
});

describe('las filas de la descarga', () => {
  const pages = (sizes: number[]) => {
    const asked: Array<string | undefined> = [];
    const fetchPage = async (cursor: string | undefined) => {
      asked.push(cursor);
      const at = cursor ? Number(cursor) : 0;
      return { items: Array.from({ length: sizes[at]! }, (_, i) => row({ id: `${at}-${i}` })), nextCursor: at + 1 < sizes.length ? String(at + 1) : null };
    };
    return { asked, fetchPage };
  };

  it('recorre todas las páginas hasta el final, diciendo cuántas lleva', async () => {
    const { asked, fetchPage } = pages([200, 200, 34]);
    const progress: number[] = [];
    const out = await collectCobros(fetchPage, (n) => progress.push(n));
    expect(out.rows).toHaveLength(434);
    expect(out.capped).toBe(false);
    expect(asked).toEqual([undefined, '1', '2']);
    expect(progress).toEqual([200, 400]);
  });

  it('para en el tope y lo dice; justo en el tope y sin más páginas, no avisa', async () => {
    const over = await collectCobros(pages([200, 200, 200]).fetchPage, undefined, 300);
    expect(over.rows).toHaveLength(300);
    expect(over.capped).toBe(true);
    const more = await collectCobros(pages([200, 100, 50]).fetchPage, undefined, 300);
    expect(more).toMatchObject({ capped: true });
    expect(more.rows).toHaveLength(300);
    const exact = await collectCobros(pages([200, 100]).fetchPage, undefined, 300);
    expect(exact).toMatchObject({ capped: false });
    expect(exact.rows).toHaveLength(300);
  });

  it('si una página falla, falla todo: no hay archivo a medias', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      if (calls === 2) throw new Error('sin red');
      return { items: [row()], nextCursor: 'x' };
    };
    await expect(collectCobros(failing)).rejects.toThrow('sin red');
  });
});
