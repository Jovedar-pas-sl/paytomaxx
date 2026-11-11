// El mapa del dinero en cuatro preguntas (Grafito 3, opción B). Cada cifra sale
// de un campo que el API ya calcula (MoneyMap, contratos); aquí solo se elige
// el campo y se escribe lo que es de verdad. Ninguna cuenta nueva:
//
//   ¿Cuánto he ganado?                   split.venueCents
//   ¿Cuánto tiene que haber en la caja?  where.cashBoxCents
//   ¿Cuánto llega al banco?              where.bbvaCents (devoluciones: outflow.refunds.cardCents)
//   ¿Cuánto debo a las compañeras?       where.owed.chicasCents, o si no se sabe
//                                        outflow.pendingStaff.chicasCents
//   Saldo de clientes sin gastar         where.liveSaldoCents
//   Lo vendido                           salesCents y sections (moneyMapView)

import type { MoneyMap, VenueSection } from '@nightpay/contracts';
import { eurShort, moneyMapIsCurrent, moneyMapView, type SectionRow } from './money-map-view';

export type QuestionKey = 'ganado' | 'caja' | 'banco' | 'debo';

export interface QuestionCard {
  key: QuestionKey;
  question: string;
  cents: number;
  /** Qué es de verdad esa cifra (y qué no cuenta). */
  caption: string;
  /** Botón de la tarjeta: «Cerrar la caja» o «Ver por compañera» (null: ninguno). */
  action: 'close-cash' | 'by-person' | null;
}

export interface MoneyMapQuestions {
  cards: QuestionCard[];
  /** El saldo de los clientes que aún no han gastado; cents null = no se sabe en estas fechas. */
  savedBalance: { cents: number | null; text: string };
  sold: { label: string; cents: number; parts: SectionRow[] };
}

/** «Fondo de caja 200 € + efectivo cobrado 1.070 € − salidas 70 €». */
function cashCaption(m: MoneyMap): string {
  const box = m.where.cashBox;
  const float = box.openingFloatCents;
  const parts = [
    float === null ? 'Sin fondo de caja apuntado' : `Fondo de caja ${eurShort(float)}`,
    `+ efectivo cobrado ${eurShort(box.inCents)}`,
    `− salidas ${eurShort(box.outCents)}`,
  ];
  return `${parts.join(' ')}. No sustituye al arqueo.`;
}

function bankCaption(m: MoneyMap): string {
  const refunded = m.outflow.refunds.cardCents;
  const base = 'Lo cobrado con tarjeta (ventas y recargas)';
  const net = refunded > 0 ? `${base}, menos ${eurShort(refunded)} devueltos.` : `${base}.`;
  return `${net} El día de abono lo confirma el banco.`;
}

function ownedCard(m: MoneyMap): Pick<QuestionCard, 'cents' | 'caption'> {
  const when = moneyMapIsCurrent(m) ? 'ahora' : 'al corte';
  const owed = m.where.owed;
  const waiters = (owed ? owed.camarerosCents : m.outflow.pendingStaff.camarerosCents) > 0;
  const waitersCents = owed ? owed.camarerosCents : m.outflow.pendingStaff.camarerosCents;
  const extra = waiters ? ` Aparte, a camareros: ${eurShort(waitersCents)}.` : '';
  if (owed) {
    return { cents: owed.chicasCents, caption: `Lo que se les debe ${when}, de esta noche y de antes.${extra}` };
  }
  return {
    cents: m.outflow.pendingStaff.chicasCents,
    caption: `Lo que han ganado en estas fechas y aún no se les ha pagado (la deuda total ${when} no se conoce).${extra}`,
  };
}

function ganadoCaption(m: MoneyMap): string {
  const who = m.split.camarerosCents > 0 ? 'las compañeras, los camareros' : 'las compañeras';
  const bank = m.split.commissions.bankCents === null ? ' Sin la comisión del banco: sale en su extracto.' : '';
  return `Lo tuyo: lo vendido menos lo de ${who} y las comisiones.${bank}`;
}

export function moneyMapQuestions(m: MoneyMap, sections: readonly VenueSection[]): MoneyMapQuestions {
  const v = moneyMapView(m, sections);
  const current = moneyMapIsCurrent(m);
  const owned = ownedCard(m);
  const live = m.where.liveSaldoCents;
  return {
    cards: [
      { key: 'ganado', question: '¿Cuánto he ganado?', cents: m.split.venueCents, caption: ganadoCaption(m), action: null },
      {
        key: 'caja',
        question: '¿Cuánto tiene que haber en la caja?',
        cents: m.where.cashBoxCents,
        caption: cashCaption(m),
        action: current ? 'close-cash' : null,
      },
      { key: 'banco', question: '¿Cuánto llega al banco?', cents: m.where.bbvaCents, caption: bankCaption(m), action: null },
      { key: 'debo', question: '¿Cuánto debo a las compañeras?', cents: owned.cents, caption: owned.caption, action: 'by-person' },
    ],
    savedBalance: {
      cents: live,
      text:
        live === null
          ? 'No se sabe cuánto saldo de clientes queda sin gastar en estas fechas.'
          : `${eurShort(live)} son saldo de clientes sin gastar${current ? '' : ' al corte'}: siguen siendo suyos hasta que lo gasten o se lo devuelvas.`,
    },
    sold: { label: v.salesLabel, cents: m.salesCents, parts: v.sections.filter((s) => s.cents !== 0) },
  };
}
