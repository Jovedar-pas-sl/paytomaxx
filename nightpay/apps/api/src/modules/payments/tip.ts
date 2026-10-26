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

/** Hasta este importe se sugieren euros fijos; por encima, porcentajes. */
export const TIP_FLAT_UP_TO_CENTS = 40_00;
/** Propinas sugeridas para importes pequeños: +2 € y +5 €. */
export const TIP_FLAT_PRESETS_CENTS: readonly number[] = [200, 500];
/** Propinas sugeridas para el resto: 10 % y 15 %, en euros enteros. */
export const TIP_PERCENT_PRESETS: readonly number[] = [10, 15];

/** Propina sugerida: su importe y, si sale de un porcentaje, cuál. */
export interface TipPreset {
  cents: number;
  percent: number | null;
}

/** Propinas sugeridas que eligió el local (Ajustes → Formas de cobro); sin ellas, las de siempre. */
export interface TipPresetConfig {
  flatCents?: readonly number[];
  percents?: readonly number[];
}

/**
 * Propinas sugeridas para un importe (además de «Sin propina» y «Otra»).
 * Las que pasarían del máximo no se sugieren.
 */
export function tipPresetsFor(amountCents: number, config: TipPresetConfig = {}): TipPreset[] {
  const cap = maxTipCents(amountCents);
  const flat = config.flatCents?.length ? config.flatCents : TIP_FLAT_PRESETS_CENTS;
  const percents = config.percents?.length ? config.percents : TIP_PERCENT_PRESETS;
  const raw: TipPreset[] =
    amountCents <= TIP_FLAT_UP_TO_CENTS
      ? flat.map((cents) => ({ cents, percent: null }))
      : percents.map((percent) => ({
          cents: Math.max(100, Math.round((amountCents * percent) / 10_000) * 100),
          percent,
        }));
  const seen = new Set<number>();
  return raw.filter((t) => {
    if (t.cents > cap || seen.has(t.cents)) return false;
    seen.add(t.cents);
    return true;
  });
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

/** Propina como mucho del importe del cobro y nunca más de esto. */
export const MAX_TIP_CENTS = 500_00;

/** Propina máxima para un cobro de este importe (la misma regla en el datáfono). */
export function maxTipCents(amountCents: number): number {
  return Math.max(0, Math.min(amountCents, MAX_TIP_CENTS));
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
