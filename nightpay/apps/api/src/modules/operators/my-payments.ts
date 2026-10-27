import type { CobroRow } from '@nightpay/contracts';

/**
 * «Mis cobros» de la app de la chica de antes (GET /v1/operators/me/payments).
 * La app de ahora usa /v1/staff/me/cobros, la lista del panel, como el resto
 * del personal; esta se queda para la app que siga abierta mientras se
 * despliega (primero el API, luego la app) y le da lo mismo con su forma de
 * siempre: un cobro = una fila. El cobro con tarjeta que se canceló solo porque
 * lo pagó el saldo no sale (cobros.service NOT_SALDO_TWIN) y el cobro del saldo
 * sí, con un estado que la app de antes ya sabe pintar.
 */
export interface MyPaymentRow {
  /** PAYMENT: cobro con tarjeta (o datáfono). SALDO: cobro del saldo. Nuevo: la app de antes no lo lee. */
  kind: 'PAYMENT' | 'SALDO';
  id: string;
  amountCents: number;
  currency: string;
  /** Los del saldo: AUTHORIZED (pagado) o REFUNDED (consumo anulado: vuelto al saldo). */
  status: string;
  provider: string | null;
  createdAt: Date;
  /** Solo los cobros con tarjeta. */
  qrToken: string | null;
  qrExpiresAt: Date | null;
}

/** Un cobro con tarjeta de la chica, como lo lee la lista (payments). */
export interface CardPaymentLike {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  provider: string | null;
  createdAt: Date;
  qrToken: string;
  qrExpiresAt: Date;
}

/** El cobro del saldo con un estado de la app de antes: «Pago completado» o, anulado, «Reembolsado». */
export function saldoAsMyPayment(row: Pick<CobroRow, 'id' | 'amountCents' | 'currency' | 'status' | 'createdAt'>): MyPaymentRow {
  return {
    kind: 'SALDO',
    id: row.id,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status === 'REVERSED' ? 'REFUNDED' : 'AUTHORIZED',
    provider: null,
    createdAt: new Date(row.createdAt),
    qrToken: null,
    qrExpiresAt: null,
  };
}

/** Los dos juntos, más nuevos primero (a la misma hora, el id mayor), los `limit` primeros. */
export function myPaymentsPage(cards: readonly CardPaymentLike[], saldo: readonly CobroRow[], limit: number): MyPaymentRow[] {
  const rows: MyPaymentRow[] = [...cards.map((c) => ({ kind: 'PAYMENT' as const, ...c })), ...saldo.map(saldoAsMyPayment)];
  return rows
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, limit);
}
