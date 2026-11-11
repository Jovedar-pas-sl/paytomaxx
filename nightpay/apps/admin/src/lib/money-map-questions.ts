// El mapa del dinero en cuatro preguntas (Grafito 3, opción B). Cada cifra sale
// de campos que el API ya calcula (MoneyMap, contratos); aquí solo se eligen y
// se escribe lo que es de verdad. Ninguna cuenta nueva salvo una resta:
//
//   ¿Cuánto he ganado?                   split.venueCents − outflow.refunds.salesCents
//                                        (venueEarnedCents: lo del local menos lo devuelto de ventas)
//   ¿Cuánto tiene que haber en la caja?  where.cashBoxCents, solo en una noche; en unas fechas
//                                        o sin noche abierta, el efectivo del periodo (entradas − salidas)
//   ¿Cuánto llega al banco?              where.bbvaCents (devoluciones: outflow.refunds.cardCents)
//   ¿Cuánto debo a las compañeras?       where.owed.chicasCents (por persona, sin compensar;
//                                        la deuda por devoluciones, owed.debtCents, aparte),
//                                        o si no se sabe outflow.pendingStaff.chicasCents
//   Saldo de clientes sin gastar         where.liveSaldoCents
//   Lo vendido                           salesCents y sections (moneyMapView)
//
// Una cifra negativa se explica en su texto (y se pinta de aviso, no en verde).

import { venueEarnedCents, type MoneyMap, type VenueSection } from '@nightpay/contracts';
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

type Card = Omit<QuestionCard, 'key'>;

/** La noche abierta, en directo: la única desde la que se puede «Cerrar la caja». */
function isOpenNight(m: MoneyMap): boolean {
  return m.scope.kind === 'night' && m.scope.open && !m.frozen;
}

/** Lo del local menos lo devuelto de ventas (venueEarnedCents). Una noche cerrada antes de llevar esa cuenta no lo trae: se dice. */
function earnedCard(m: MoneyMap): Card {
  const refunds = m.outflow.refunds;
  const refunded = refunds.salesCents ?? 0;
  const cents = venueEarnedCents(m);
  const who = m.split.camarerosCents > 0 ? 'las compañeras, los camareros' : 'las compañeras';
  const minus = refunded > 0 ? `, y menos ${eurShort(refunded)} devueltos de ventas` : '';
  const bank = m.split.commissions.bankCents === null ? ' Sin la comisión del banco: sale en su extracto.' : '';
  // Un mapa guardado antes de separar lo devuelto de ventas: la cifra va sin restar, y se avisa.
  const unknown =
    refunds.salesCents === undefined && refunds.cardCents > 0
      ? ` No descuenta los ${eurShort(refunds.cardCents)} devueltos a tarjeta: en esta noche, ya cerrada, no se sabe cuánto era de ventas.`
      : '';
  const negative = cents < 0 ? ' Sale negativo: en estas fechas se devolvió más de lo que se ganó.' : '';
  return {
    question: '¿Cuánto he ganado?',
    cents,
    caption: `Lo tuyo: lo vendido menos lo de ${who} y las comisiones${minus}.${bank}${unknown}${negative}`,
    action: null,
  };
}

/** «Fondo de caja 200 € + efectivo cobrado 1.070 € − salidas 70 €»; sin una noche con su fondo, solo el efectivo del periodo. */
function cashCard(m: MoneyMap): Card {
  const box = m.where.cashBox;
  const cents = m.where.cashBoxCents;
  // En unas fechas, o de día sin noche abierta (desde el último cierre), el API no cuenta
  // ningún fondo (va por noche): no es «lo que tiene que haber en la caja».
  const noNight = m.scope.kind === 'night' && m.scope.nightId === null;
  if (m.scope.kind === 'period' || noNight) {
    return {
      question: noNight ? 'Efectivo desde el último cierre' : 'Efectivo de estas fechas',
      cents,
      caption: `Efectivo cobrado ${eurShort(box.inCents)} − salidas ${eurShort(box.outCents)}. El fondo y el arqueo van por noche: míralos en Noches.`,
      action: null,
    };
  }
  const float = box.openingFloatCents;
  const parts = [
    float === null ? 'Sin fondo de caja apuntado' : `Fondo de caja ${eurShort(float)}`,
    `+ efectivo cobrado ${eurShort(box.inCents)}`,
    `− salidas ${eurShort(box.outCents)}`,
  ];
  const negative = cents < 0 ? (float === null ? ' Sale negativo: ¿falta apuntar el fondo de caja?' : ' Sale negativo: revisa las salidas de caja.') : '';
  return {
    question: '¿Cuánto tiene que haber en la caja?',
    cents,
    caption: `${parts.join(' ')}. No sustituye al arqueo.${negative}`,
    action: isOpenNight(m) ? 'close-cash' : null,
  };
}

function bankCard(m: MoneyMap): Card {
  const refunded = m.outflow.refunds.cardCents;
  const base = 'Lo cobrado con tarjeta (ventas y recargas)';
  const net = refunded > 0 ? `${base}, menos ${eurShort(refunded)} devueltos.` : `${base}.`;
  const cents = m.where.bbvaCents;
  const negative = cents < 0 ? ' Sale negativo: se devolvió más de lo que se cobró con tarjeta, y el banco lo descontará.' : '';
  return { question: '¿Cuánto llega al banco?', cents, caption: `${net} El día de abono lo confirma el banco.${negative}`, action: null };
}

function owedCard(m: MoneyMap): Card {
  const question = '¿Cuánto debo a las compañeras?';
  const when = moneyMapIsCurrent(m) ? 'ahora' : 'al corte';
  const owed = m.where.owed;
  const waitersCents = owed ? owed.camarerosCents : m.outflow.pendingStaff.camarerosCents;
  const extra = waitersCents > 0 ? ` Aparte, a camareros: ${eurShort(waitersCents)}.` : '';
  if (owed) {
    const debt = owed.debtCents ?? 0;
    const owing = debt > 0 ? ` Y te deben ${eurShort(debt)} por devoluciones: se descuenta de su próximo pago.` : '';
    return {
      question,
      cents: owed.chicasCents,
      caption: `Lo que se les debe ${when}, de esta noche y de antes, sumando lo de cada una.${extra}${owing}`,
      action: 'by-person',
    };
  }
  const cents = m.outflow.pendingStaff.chicasCents;
  const negative = cents < 0 ? ' Sale negativo: las devoluciones de estas fechas pesan más que lo ganado.' : '';
  return {
    question,
    cents,
    caption: `Lo que han ganado en estas fechas y aún no se les ha pagado (la deuda total ${when} no se conoce).${extra}${negative}`,
    action: 'by-person',
  };
}

export function moneyMapQuestions(m: MoneyMap, sections: readonly VenueSection[]): MoneyMapQuestions {
  const v = moneyMapView(m, sections);
  const current = moneyMapIsCurrent(m);
  const live = m.where.liveSaldoCents;
  return {
    cards: [
      { key: 'ganado', ...earnedCard(m) },
      { key: 'caja', ...cashCard(m) },
      { key: 'banco', ...bankCard(m) },
      { key: 'debo', ...owedCard(m) },
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
