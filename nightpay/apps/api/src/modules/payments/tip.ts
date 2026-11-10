import { BadRequestException } from '@nestjs/common';
import {
  STAFF_TIP_REMOVED_CODE,
  STAFF_TIP_REMOVED_MESSAGE,
  maxTipCents,
  type CustomerTipProblem,
  tipPresetsFor,
  type TipPresetConfig,
} from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * Propina que elige el cliente en la página de pago (Fase 1B).
 *
 * Se cobra en la tarjeta junto al importe: cada intento manda al banco
 * importe + propina, y la propina del intento que el banco aprueba es la que
 * pasa al cobro, en la misma transacción que lo marca AUTHORIZED y reparte la
 * comisión (aviso del banco, conciliación automática o resolución a mano).
 * Solo con Redsys: el resto de pasarelas cobran el importe, como antes.
 */

// Las sugeridas y el máximo, en contracts (también los usa la app del personal
// en la pantalla del PIN, B1).
export {
  MAX_TIP_CENTS,
  TIP_FLAT_PRESETS_CENTS,
  TIP_FLAT_UP_TO_CENTS,
  TIP_PERCENT_PRESETS,
  maxTipCents,
  tipPresetsFor,
  type TipPreset,
  type TipPresetConfig,
} from '@nightpay/contracts';

/**
 * B1: la propina solo la pone el cliente al pagar. Una app del personal de
 * antes que aún la mande al crear el cobro recibe esto (400): ignorarla en
 * silencio dejaría al personal esperando una propina que nadie paga.
 */
export function staffTipRemoved(): BadRequestException {
  return new BadRequestException({ message: STAFF_TIP_REMOVED_MESSAGE, code: STAFF_TIP_REMOVED_CODE });
}

/** El código del 400 de una propina del cliente que no vale (la página lo traduce). */
export const TIP_NOT_VALID_CODE = 'TIP_NOT_VALID';

const CUSTOMER_TIP_MESSAGE: Record<CustomerTipProblem, string> = {
  invalid: 'Propina no válida',
  'too-high': 'La propina no puede pasar del importe del cobro ni de 500,00 €',
  'tips-off': 'En este cobro no se puede dejar propina',
};

/** La propina que eligió el cliente al pagar con su saldo o su PIN no vale (B1): 400. */
export function customerTipError(problem: CustomerTipProblem): BadRequestException {
  return new BadRequestException({ message: CUSTOMER_TIP_MESSAGE[problem], code: TIP_NOT_VALID_CODE, reason: problem });
}

/**
 * Propinas que se ofrecen como botón. Sin propina si no se puede (recarga de
 * wallet u otra pasarela). Si el cobro ya traía una propina puesta por el
 * local, también se ofrece (nunca marcada: la marcada es «Sin propina»).
 */
export function tipOptionsFor(p: {
  amountCents: number;
  tipCents: number;
  allowTip: boolean;
  tipPresets?: TipPresetConfig;
}): number[] {
  if (!p.allowTip) return [0];
  const presets = tipPresetsFor(p.amountCents, p.tipPresets).map((t) => t.cents);
  return [...new Set([0, ...presets, p.tipCents])].sort((a, b) => a - b);
}

/**
 * ¿Vale la propina que eligió el cliente? «Sin propina» siempre. Si se puede
 * dejar propina, cualquier importe entero de céntimos hasta el máximo (las
 * sugeridas y la de «Otra»), o la que ya traía el cobro.
 */
export function tipChoiceAllowed(
  p: { amountCents: number; tipCents: number; allowTip: boolean },
  chosenCents: number,
): boolean {
  if (!Number.isInteger(chosenCents) || chosenCents < 0) return false;
  if (chosenCents === 0) return true;
  if (!p.allowTip) return false;
  return chosenCents <= maxTipCents(p.amountCents) || chosenCents === p.tipCents;
}

/** Si lo cobró una chica, la propina es suya; si no, del local. */
export function defaultTipGoesTo(creatorRole: string | null | undefined): 'operator' | 'venue' {
  return creatorRole === 'OPERATOR' ? 'operator' : 'venue';
}

/**
 * ¿Va la propina entera a una persona del personal? Solo entonces se le dice
 * al cliente «Va entera para el personal»; si es del local, no se dice.
 */
export function tipGoesToStaff(p: { tipGoesTo: string | null; creatorRole: string | null }): boolean {
  if (p.tipGoesTo === 'beneficiary') return true;
  if (p.tipGoesTo) return p.tipGoesTo === 'operator' && p.creatorRole === 'OPERATOR';
  return defaultTipGoesTo(p.creatorRole) === 'operator';
}

/**
 * ¿Vale la propina que pone quien crea el cobro? Solo si la cobra el banco y
 * nos dice cuánta cobró (Redsys, con la página de pago): esa es la que
 * cuenta al pagarse. Por datáfono la dice el datáfono; en el resto (otras
 * pasarelas, recargas de saldo) no se cobra propina, así que no se apunta:
 * si no, sería dinero inventado para la chica y para las devoluciones.
 */
export function creatorTipConfirmable(args: {
  provider: string | null;
  isPosExternal: boolean;
  isWalletTopUp: boolean;
}): boolean {
  return args.provider === 'REDSYS' && !args.isPosExternal && !args.isWalletTopUp;
}

/**
 * La chica solo da la propina para ella o para el local. Para otra persona
 * se perdería: su comisión y esa propina irían al mismo cobro (una sola fila
 * de comisión por cobro).
 */
export function tipDestinationAllowed(
  creatorRole: string | null | undefined,
  tipGoesTo: string | null | undefined,
): boolean {
  if (creatorRole !== 'OPERATOR' || !tipGoesTo) return true;
  return tipGoesTo === 'operator' || tipGoesTo === 'venue';
}

/**
 * Campos del cobro una vez se sabe qué propina cobró el banco. Lo devolvible:
 * todo lo cobrado en la tarjeta, con la «Comisión del servicio» devolvible
 * (`serviceFeeCents`: la de un pago directo; la de una recarga, nunca).
 */
export function settleChargedTip(args: {
  amountCents: number;
  tipCents: number;
  tipGoesTo: string | null;
  creatorRole: string | null;
  serviceFeeCents?: number;
}): { tipCents: number; availableAmountCents: number; tipGoesTo: string | null } {
  const base = args.amountCents + Math.max(0, args.serviceFeeCents ?? 0);
  if (args.tipCents <= 0) {
    return { tipCents: 0, availableAmountCents: base, tipGoesTo: null };
  }
  return {
    tipCents: args.tipCents,
    // Lo que se puede devolver: todo lo cobrado en la tarjeta.
    availableAmountCents: base + args.tipCents,
    tipGoesTo: args.tipGoesTo ?? defaultTipGoesTo(args.creatorRole),
  };
}

export type ChargedTip =
  | { ok: true; tipCents: number | null }
  | { ok: false; reason: 'unknown-order' | 'ambiguous' };

/**
 * Al resolver a mano un cobro atascado: qué propina cobró el banco.
 *  - Con el número de pedido que se ve en el portal del banco → la de ese intento.
 *  - Sin él, solo si todos los intentos llevaban la misma propina.
 * `tipCents: null` = intentos anteriores a la Fase 1B: no se toca la propina.
 */
export function chargedAttemptTip(
  attempts: ReadonlyArray<{ providerTxId: string; tipCents: number | null }>,
  bankOrder?: string,
): ChargedTip {
  if (bankOrder) {
    const hit = attempts.find((a) => a.providerTxId === bankOrder);
    return hit ? { ok: true, tipCents: hit.tipCents } : { ok: false, reason: 'unknown-order' };
  }
  const tips = new Set(attempts.map((a) => a.tipCents));
  if (tips.size > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, tipCents: attempts[0]?.tipCents ?? null };
}

/**
 * Propina del intento que cobró el banco (`providerTxId` del evento
 * AUTHORIZED) y rol de quien creó el cobro. `null` = no consta qué propina
 * cobró (otra pasarela, que solo cobra el importe, o intento anterior a la
 * Fase 1B): transition() la deja a 0. SQL crudo: se llama dentro de
 * transition(), fuera del middleware de tenant.
 */
export async function readChargedTip(
  tx: TransactionalClient,
  paymentId: string,
  event: { provider: string; providerTxId: string },
): Promise<{ tipCents: number; creatorRole: string | null } | null> {
  const rows = await tx.$queryRaw<Array<{ tipCents: number | null; creatorRole: string | null }>>`
    SELECT a."tipCents", u.role::text AS "creatorRole"
      FROM payment_attempts a
      JOIN payments p ON p.id = a."paymentId"
      LEFT JOIN users u ON u.id = p."createdByUserId"
     WHERE a."paymentId" = ${paymentId}::uuid
       AND a.provider = ${event.provider}::"Provider"
       AND a."providerTxId" = ${event.providerTxId}
  `;
  const row = rows[0];
  if (!row || row.tipCents === null) return null;
  return { tipCents: row.tipCents, creatorRole: row.creatorRole };
}
