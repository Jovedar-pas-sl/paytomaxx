import { z } from 'zod';
import { UuidSchema } from './common';

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
  /** OxioPay: su % sobre lo vendido (sin propinas). */
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
   * saldo devuelto) y el resto, tuyo.
   */
  owners: { venueCents: number; staffCents: number; saldoCents: number };
  /** Saldo vivo de los clientes del local ahora (o al cerrar); null si no se sabe (periodo pasado). */
  liveSaldoCents: number | null;
  /** Lo que se debe al personal ahora (o al cerrar), de esta noche y de antes; null si no se sabe. */
  owed: { chicasCents: number; camarerosCents: number } | null;
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
}

/** % de lo vendido que se queda el local (para el anillo), de 0 a 100. */
export function venueSharePercent(m: Pick<MoneyMap, 'salesCents' | 'split'>): number {
  if (m.salesCents <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((m.split.venueCents * 100) / m.salesCents)));
}
