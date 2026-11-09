import { z } from 'zod';
import type { ChargeMethod, CobroPerson, SectionAmount } from './charge-lines';
import { UuidSchema } from './common';
import type { InvitationShare } from './invitations';

/**
 * El mapa del dinero del panel (maqueta 8 · A, barras apiladas): una noche
 * (en directo, o congelada en su Z al cerrar) o unas fechas, en cinco
 * carriles, en el orden del dinero:
 *   1. Cómo entra: tarjeta (y Apple Pay / Google Pay y datáfono), efectivo y
 *      del saldo. Las recargas van aparte: no son venta.
 *   2. Por sección: cada línea de cobro en su sección; las propinas, aparte.
 *   3. Cómo se reparte: el local, las chicas, los camareros y las comisiones.
 *   4. Dónde está: en BBVA (lo abona mañana) y en la caja; y de quién es.
 *   5. Qué sale: pagos al personal, devoluciones y comisiones.
 * Sin IVA en ninguna parte: eso lo lleva la gestoría. Todo en céntimos.
 */

/** «Propinas» en la lista de secciones: no es una línea de cobro (tipCents). */
export const MONEY_MAP_TIPS = 'TIPS' as const;

export const MoneyMapQuerySchema = z
  .object({
    /** «current» (la abierta, en directo) o el id de una noche. */
    night: z.union([z.literal('current'), UuidSchema]).optional(),
    /** Días de Madrid, AAAA-MM-DD, ambos incluidos (en vez de una noche). */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD').optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD').optional(),
  })
  .strict()
  .refine((q) => !(q.night && (q.from || q.to)), { message: 'Pide una noche o unas fechas, no las dos cosas' })
  .refine((q) => Boolean(q.from) === Boolean(q.to), { message: 'Faltan las fechas: from y to' });
export type MoneyMapQuery = z.infer<typeof MoneyMapQuerySchema>;

export type MoneyMapScope =
  /** Una noche: la abierta (nightId null si no hay ninguna: desde el último cierre). */
  | { kind: 'night'; nightId: string | null; open: boolean }
  | { kind: 'period' };

/** 1 · Cómo entra (solo ventas: importe + propina). */
export interface MoneyMapInflow {
  /** Tarjeta, Apple Pay / Google Pay y datáfono: todo lo que abona el banco. */
  cardRailCents: number;
  cardCents: number;
  mobileWalletCents: number;
  posCents: number;
  /** Cobros en efectivo (hoy el efectivo solo entra como recarga: suele ser 0). */
  cashCents: number;
  /** Consumos del saldo del cliente (el dinero entró con la recarga). */
  saldoCents: number;
  /** Recargas del saldo: dinero del cliente aún sin gastar, no es venta. */
  topUps: { totalCents: number; cardCents: number; cashCents: number; count: number };
  /**
   * «Comisión del servicio» que pagaron los clientes encima (pagos directos y
   * recargas, con tarjeta y en efectivo): entra con el resto, pero se debe a
   * OxioPay (serviceFee). No es venta. Los mapas congelados antes del
   * 2026-10-26 no lo traen.
   */
  serviceFeeCents?: number;
}

/** 2 · Una sección (o MONEY_MAP_TIPS para las propinas, o EXTRA para los cobros antiguos). */
export interface MoneyMapSection {
  code: string;
  amountCents: number;
  /** Cobros que tienen algo en esta sección. */
  count: number;
}

/** 3 · Cómo se reparte lo vendido. */
export interface MoneyMapSplit {
  /** Lo que queda para el local: ventas − chicas − camareros − comisiones. */
  venueCents: number;
  /** Comisión y propinas de las chicas por lo vendido. */
  chicasCents: number;
  /** La parte de los camareros (invitaciones). */
  camarerosCents: number;
  commissions: MoneyMapCommissions;
}

export interface MoneyMapCommissions {
  /**
   * OxioPay: su % antiguo sobre lo vendido (sin propinas). Con la «Comisión
   * del servicio» encendida, 0 en esas ventas (la paga el cliente: serviceFee).
   */
  platformCents: number;
  /** El banco, con la tasa configurada (BANK_CARD_FEE_BPS); null = no se sabe: sale en el extracto de BBVA. */
  bankCents: number | null;
  totalCents: number;
}

/** 4 · Dónde está el dinero del periodo y de quién es. */
export interface MoneyMapWhere {
  /** Lo cobrado por el banco en el periodo (ventas y recargas) − lo devuelto a la tarjeta: lo abona mañana. */
  bbvaCents: number;
  /** Lo que debería haber en la caja (como el arqueo del cierre: fondo + entradas − salidas en efectivo). */
  cashBoxCents: number;
  cashBox: { openingFloatCents: number | null; inCents: number; outCents: number };
  totalCents: number;
  /**
   * De quién es ese total (suman lo mismo): lo del personal de este periodo
   * aún sin pagar, el saldo vivo que dejó el periodo (recargas − consumos −
   * saldo devuelto), lo ya pagado por banco o transferencia (BBVA no lo
   * descuenta), las comisiones y el resto, tuyo.
   */
  owners: {
    venueCents: number;
    staffCents: number;
    saldoCents: number;
    /** La «Comisión del servicio» de este periodo que se debe a OxioPay. Mapas de antes: sin el campo. */
    oxioPayCents?: number;
    /** Pagado al personal por banco o transferencia en este periodo (lo de efectivo ya salió de la caja). Mapas de antes: sin el campo. */
    paidOutCents?: number;
    /** Comisiones de este periodo: la de OxioPay y la estimada del banco. Mapas de antes: sin el campo. */
    commissionsCents?: number;
  };
  /** Saldo vivo de los clientes del local ahora (o al cerrar); null si no se sabe (periodo pasado). */
  liveSaldoCents: number | null;
  /** Lo que se debe al personal ahora (o al cerrar), de esta noche y de antes; null si no se sabe. */
  owed: {
    chicasCents: number;
    camarerosCents: number;
    /**
     * De lo debido, lo de ventas por datáfono sin cuadrar con el banco (bank-hold):
     * no se paga hasta cuadrarlas o liberarlas. Mapas de antes: sin el campo.
     */
    bankHeldCents?: number;
  } | null;
}

/** Un grupo de pagos al personal hechos en el periodo. */
export interface MoneyMapPayoutGroup {
  who: 'chicas' | 'camareros';
  /** Vía (MANUAL_CASH, BANK_WIRE…); null = sin decir. */
  rail: string | null;
  count: number;
  cents: number;
}

/** 5 · Qué sale. */
export interface MoneyMapOutflow {
  payouts: MoneyMapPayoutGroup[];
  /** Lo del personal de este periodo aún sin pagar: sale al pagarles. */
  pendingStaff: { chicasCents: number; camarerosCents: number };
  refunds: { cardCents: number; cardCount: number; cashCents: number; cashCount: number };
  commissionsCents: number;
  /** La «Comisión del servicio» que se debe a OxioPay: sale al liquidársela. Mapas de antes: sin el campo. */
  serviceFeeCents?: number;
}

/**
 * «Comisión del servicio» del periodo (service-fee.ts): la pagó el cliente
 * encima del precio, entra entera al local (su banco o su caja) y se debe a
 * OxioPay.
 */
export interface MoneyMapServiceFee {
  /** De los pagos directos con tarjeta, Apple Pay / Google Pay o datáfono. */
  salesCents: number;
  /** De las recargas del saldo (con tarjeta y en efectivo). */
  topUpsCents: number;
  /** …de ellas, en efectivo: está en la caja. */
  cashCents: number;
  /** Devuelta al cliente con las devoluciones del periodo. */
  refundedCents: number;
  /** Lo que se debe a OxioPay: la cobrada − la devuelta. */
  owedCents: number;
}

export interface MoneyMap {
  scope: MoneyMapScope;
  from: string;
  to: string;
  generatedAt: string;
  /** Congelado en el Z al cerrar la noche (ya no cambia). */
  frozen: boolean;
  /** Ventas: importe + propinas (sin recargas). */
  salesCents: number;
  /** Cuántos cobros (con tarjeta y del saldo). */
  salesCount: number;
  inflow: MoneyMapInflow;
  sections: MoneyMapSection[];
  split: MoneyMapSplit;
  where: MoneyMapWhere;
  outflow: MoneyMapOutflow;
  /** «Comisión del servicio» (se debe a OxioPay). Los mapas congelados antes del 2026-10-26 no la traen. */
  serviceFee?: MoneyMapServiceFee;
}

/** % de lo vendido que se queda el local (para el anillo), de 0 a 100. */
export function venueSharePercent(m: Pick<MoneyMap, 'salesCents' | 'split'>): number {
  if (m.salesCents <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((m.split.venueCents * 100) / m.salesCents)));
}

// ─── Ficha de la chica (y del camarero) · maqueta 9.2 ──────────────────

/** Lo que le toca de cada cosa (los chips de la ficha). */
export type StaffRate =
  /** Su % de una sección (el suyo o el del local). */
  | { kind: 'section'; code: string; bps: number }
  /** Su parte de una invitación («Copa con invitación»). */
  | { kind: 'invitation'; share: InvitationShare }
  /** Las propinas que le dejan a ella. */
  | { kind: 'tips'; bps: number };

/**
 * Un cobro de esta noche en el que le toca algo (una ganancia) o, con
 * `refundOf`, una devolución de esta noche de un cobro de otra noche, que
 * solo le resta su parte (como en el mapa del dinero y el Z).
 */
export interface StaffFichaRow {
  /** La ganancia (operator_earnings); en una devolución de otra noche, su descuento (earning_reversals). */
  id: string;
  at: string;
  /** Referencia corta del cobro (C-0001). */
  ref: string | null;
  kind: 'PAYMENT' | 'SALDO';
  /** Sección para el color: la de la invitación o la principal del cobro. */
  section: string;
  sections: SectionAmount[];
  /** «1 h», «Invitación», «Propina»… */
  title: string;
  method: ChargeMethod | null;
  /** Por dónde se autorizó: «QR», «Datáfono», «NFC», «PIN», «Face ID»… */
  via: string | null;
  /** Código del saldo con el que pagó (los cobros del saldo). */
  walletCode: string | null;
  /** Quién lo cobró, si no fue ella (las invitaciones: el camarero). */
  chargedBy: CobroPerson | null;
  invitation: boolean;
  /** Lo vendido (en una invitación, la copa); en una devolución de otra noche, lo devuelto. */
  amountCents: number;
  /**
   * Lo suyo: comisión + propina − lo devuelto o anulado (también lo que ya
   * debe si se le había pagado). En una devolución de otra noche, lo que se le
   * descuenta (negativo).
   */
  shareCents: number;
  /** Devuelto o anulado del todo. */
  undone: boolean;
  /** Devolución de esta noche de un cobro de otra noche (cuándo se cobró): no es venta. */
  refundOf?: { chargedAt: string };
}

export interface StaffFicha {
  person: { id: string; name: string; role: 'OPERATOR' | 'WAITER' };
  /** La noche (en directo) o, sin noche abierta, desde el último cierre. */
  window: { from: string; to: string; nightId: string | null; open: boolean };
  stats: { soldCents: number; shareCents: number; paidCents: number; count: number };
  rates: StaffRate[];
  rows: StaffFichaRow[];
  /** Sus últimos pagos (de cualquier noche). */
  payouts: Array<{ id: string; at: string; cents: number; rail: string | null }>;
}
