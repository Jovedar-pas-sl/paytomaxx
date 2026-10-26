import { serviceFeeOf, type VenueServiceFee } from '@nightpay/contracts';

/**
 * «Comisión del servicio» en el API (packages/contracts/src/service-fee.ts):
 * lo que se lee del local y las cuentas de un cobro con ella. Puro.
 */

/** Lo que hay que leer de venues para saber la comisión del servicio del local. */
export const VENUE_SERVICE_FEE_SELECT = {
  serviceFeeEnabled: true,
  serviceFeeBps: true,
  topUpServiceFeeBps: true,
} as const;

export interface VenueServiceFeeRow {
  serviceFeeEnabled: boolean;
  serviceFeeBps: number;
  topUpServiceFeeBps: number;
}

/** El interruptor y los dos % del local (una fila sin los campos, o rara: apagado). */
export function venueServiceFeeOf(v: Partial<VenueServiceFeeRow> | null | undefined): VenueServiceFee {
  return serviceFeeOf({ enabled: v?.serviceFeeEnabled, cardBps: v?.serviceFeeBps, topUpBps: v?.topUpServiceFeeBps });
}

/** Lo que paga el cliente por un cobro: importe + comisión del servicio + propina. */
export function chargedCentsOf(p: { amountCents: number; serviceFeeCents?: number | null; tipCents: number }): number {
  return p.amountCents + (p.serviceFeeCents ?? 0) + p.tipCents;
}

/**
 * La comisión del servicio que se puede devolver: la de un pago directo (va
 * con la devolución, en proporción); la de una recarga, nunca («Devolver
 * saldo» devuelve solo el saldo: la comisión se la queda OxioPay).
 */
export function refundableFeeCents(p: { walletId: string | null; serviceFeeCents?: number | null }): number {
  return p.walletId ? 0 : Math.max(0, p.serviceFeeCents ?? 0);
}

/**
 * Por qué la pasarela del local no puede cobrar la «Comisión del servicio»
 * (null: puede). Peanpe en euros enteros (PEANPE_AMOUNT_FORMAT_VERIFIED=euros)
 * rechaza los importes con céntimos, y con la comisión casi todos los llevan
 * (33 € + 3,30 €): no se deja encender el interruptor en ese local.
 */
export function serviceFeeGatewayProblem(provider: string | null | undefined, peanpeFormat: string | null | undefined): string | null {
  if (provider !== 'PEANPE' || peanpeFormat !== 'euros') return null;
  return 'Este local cobra con Peanpe en euros enteros y la comisión del servicio lleva céntimos (33 € + 3,30 €): Peanpe no podría cobrarlos. Pásalo a otra pasarela, o verifica Peanpe en céntimos, antes de encenderla.';
}
