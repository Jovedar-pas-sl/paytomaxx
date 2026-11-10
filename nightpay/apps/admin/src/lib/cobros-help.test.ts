import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COBRO_ACTION_LABELS,
  COBRO_ACTION_TITLES,
  COBRO_STATES_HELP,
  COBROS_ACTIONS_HELP,
  COBROS_CASES_HELP,
  COBROS_COLUMNS_HELP,
  COBROS_HINT,
  tableStatusLabels,
} from './cobros-help';

// «Cómo leer esta tabla» de Cobros: lo que dice tiene que salir del código.
// Aquí, lo que se comprueba sin pantalla (los estados, los textos y que todo
// lo que va entre «» existe de verdad en el panel); las columnas y los
// botones, pintados, en components/CobrosHowTo.test.tsx y CobroRowActions.test.tsx.

const ALL: ReadonlyArray<{ term: string; text: string }> = [
  ...COBROS_COLUMNS_HELP,
  ...COBROS_ACTIONS_HELP,
  ...COBROS_CASES_HELP,
  ...COBRO_STATES_HELP.map((s) => ({ term: s.label, text: s.text })),
];
const TEXTS = [COBROS_HINT, ...ALL.flatMap((i) => [i.term, i.text]), ...Object.values(COBRO_ACTION_TITLES)];

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Donde están las palabras que la ayuda cita: la tabla, sus botones y diálogos, los estados y los contratos. */
const SOURCES = [
  '../components/fichas/CobrosTable.tsx',
  '../components/fichas/PaymentReferenceDetails.tsx',
  '../components/fichas/CobroDetailPanel.tsx',
  '../components/PaymentModals.tsx',
  '../components/RefundsModal.tsx',
  '../components/BankRefundModal.tsx',
  '../components/ReverseChargeModal.tsx',
  './cobro-status.ts',
  './refund-confirm.ts',
  './money-map.ts',
  '../../../../packages/contracts/src/home-topup.ts',
  '../../../../packages/contracts/src/sections.ts',
  '../../../../packages/contracts/src/charge-lines.ts',
]
  .map(src)
  .join('\n');

describe('qué significa cada estado', () => {
  it('están todos los que puede enseñar la tabla (tarjeta y saldo), y ninguno más', () => {
    const helped = COBRO_STATES_HELP.map((s) => s.label);
    expect(new Set(helped)).toEqual(new Set(tableStatusLabels()));
    expect(helped).toHaveLength(new Set(helped).size);
  });

  it('cada uno con la palabra y el color de la tabla (cobro-status)', () => {
    const pagado = COBRO_STATES_HELP.find((s) => s.label === 'Pagado');
    expect(pagado?.tone).toBe('success');
    expect(COBRO_STATES_HELP.find((s) => s.label === 'Rechazado')?.tone).toBe('danger');
    expect(COBRO_STATES_HELP.find((s) => s.label === 'Anulado')?.text).toMatch(/saldo del cliente/);
  });
});

describe('botones de cada cobro', () => {
  it('uno por botón, con su texto tal cual y en el orden de la fila', () => {
    expect(COBROS_ACTIONS_HELP.map((a) => a.term)).toEqual([
      'Ver detalle',
      'Anular cobro',
      'Resolver',
      'Devolución BBVA',
      'Reembolsar',
      'Devoluciones',
    ]);
  });

  it('dice lo que pide cada uno: 2FA, motivo, importe…', () => {
    const text = (label: string) => COBROS_ACTIONS_HELP.find((a) => a.term === label)!.text;
    expect(text('Anular cobro')).toMatch(/motivo.*2FA/);
    expect(text('Resolver')).toMatch(/Solo el dueño/);
    expect(text('Resolver')).toMatch(/15 minutos/);
    expect(text('Resolver')).toMatch(/código de autorización/);
    expect(text('Devolución BBVA')).toMatch(/Solo el dueño/);
    expect(text('Devolución BBVA')).toMatch(/importe, día, referencia del banco \(opcional\) y motivo/);
    // Con espacio duro: «100» y «€» no se separan al partir la línea.
    expect(text('Reembolsar')).toContain('100\u00a0€');
    expect(text('Devoluciones')).toMatch(/2 minutos/);
  });

  it('un title corto en cada botón (una línea al pasar el ratón)', () => {
    for (const [key, title] of Object.entries(COBRO_ACTION_TITLES)) {
      expect(title.length, key).toBeLessThanOrEqual(64);
      expect(title.length, key).toBeGreaterThan(10);
    }
    expect(Object.keys(COBRO_ACTION_TITLES).sort()).toEqual(Object.keys(COBRO_ACTION_LABELS).sort());
  });
});

describe('si pasa esto → haz esto', () => {
  it('3 o 4 casos, cada uno con el botón exacto entre «»', () => {
    expect(COBROS_CASES_HELP.length).toBeGreaterThanOrEqual(3);
    expect(COBROS_CASES_HELP.length).toBeLessThanOrEqual(4);
    const labels = Object.values(COBRO_ACTION_LABELS);
    for (const c of COBROS_CASES_HELP) {
      expect(
        labels.some((l) => c.text.includes(`«${l}»`)),
        c.term,
      ).toBe(true);
    }
  });

  it('los cuatro casos de la sala: dos veces, devolver, pendiente y el banco que no confirma', () => {
    const terms = COBROS_CASES_HELP.map((c) => c.term).join(' | ');
    expect(terms).toMatch(/dos veces/);
    expect(terms).toMatch(/devuelvan/);
    expect(terms).toMatch(/Esperando pago/);
    expect(terms).toMatch(/no confirma/);
  });
});

describe('español llano, sacado del código', () => {
  it('todo lo que va entre «» existe en el panel (un botón, un estado, una palabra de la tabla)', () => {
    const labels = new Set(Object.values(COBRO_ACTION_LABELS));
    const quoted = [...new Set(TEXTS.flatMap((t) => [...t.matchAll(/«([^»]+)»/g)].map((m) => m[1]!.replace(/…$/, ''))))];
    expect(quoted.length).toBeGreaterThan(10);
    for (const q of quoted) expect(labels.has(q) || SOURCES.includes(q), q).toBe(true);
  });

  it('sin signos de exclamación, sin emojis y sin palabras en mayúsculas (salvo las siglas)', () => {
    for (const t of TEXTS) {
      expect(t, t).not.toMatch(/[!¡]/);
      expect(t, t).not.toMatch(/\p{Extended_Pictographic}/u);
      const caps = [...t.matchAll(/\b[A-ZÁÉÍÓÚÑ]{3,}\b/g)].map((m) => m[0]);
      for (const c of caps) expect(['BBVA', 'FA'], `${c} en «${t}»`).toContain(c);
    }
  });

  it('una sola línea de ayuda, corta', () => {
    expect(COBROS_HINT.length).toBeLessThanOrEqual(90);
    expect(COBROS_HINT).not.toMatch(/\n/);
  });
});
