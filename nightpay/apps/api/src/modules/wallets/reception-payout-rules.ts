import type { ReceptionPayoutAuth, ReceptionPayoutReason, Role } from '@nightpay/contracts';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { lastNightCutoff } from '../../common/time/madrid';

/**
 * Reglas de la salida de recepción (maqueta 4.5) que no tocan la base: qué
 * hace falta para devolver un importe y cómo queda autorizado. Las usan el
 * plan (antes del PIN) y la salida (con el saldo bloqueado).
 */

export type PayoutNeeds = 'none' | 'manager_2fa' | 'manager_pending' | 'passkey_required';

export interface PayoutNeedsInput {
  role: Role;
  amountCents: number;
  /** Lo que se entrega sin el encargado: 100 € o menos si el local lo baja. */
  limitCents: number;
  /** Lo que esta persona ya devolvió en efectivo esta noche (antes de esta). */
  nightPaidCents: number;
  nightCapCents: number;
  hasPasskey: boolean;
  /** El cliente confirmó esta salida con su Face ID en su móvil. */
  passkeyConfirmed: boolean;
}

/**
 * Qué hace falta para esta salida:
 *  - el dueño: nada más (lo puede todo, como en el panel);
 *  - más de 100 € (más de 100,00 €), pasar el tope de la noche de quien
 *    devuelve o un saldo con Face ID sin confirmar: el encargado. Si devuelve
 *    él, pone su 2FA; si es recepción, queda pendiente para el encargado,
 *    salvo el Face ID, que lo confirma el cliente en su móvil (sin él, nada).
 */
export function payoutNeeds(i: PayoutNeedsInput): { needs: PayoutNeeds; reasons: ReceptionPayoutReason[] } {
  if (i.role === 'OWNER') return { needs: 'none', reasons: [] };
  const reasons: ReceptionPayoutReason[] = [];
  if (i.amountCents > i.limitCents) reasons.push('over_limit');
  if (i.nightPaidCents + i.amountCents > i.nightCapCents) reasons.push('night_cap');
  if (i.hasPasskey && !i.passkeyConfirmed) reasons.push('no_passkey');
  if (reasons.length === 0) return { needs: 'none', reasons };
  if (i.role === 'MANAGER') return { needs: 'manager_2fa', reasons };
  if (reasons.includes('no_passkey')) return { needs: 'passkey_required', reasons };
  return { needs: 'manager_pending', reasons };
}

/** Cómo quedó autorizada (la auditoría): lo del cliente y, si hizo falta, el 2FA del encargado. */
export function payoutAuthorisedBy(passkeyConfirmed: boolean, managerTwoFactor: boolean): ReceptionPayoutAuth[] {
  const out: ReceptionPayoutAuth[] = [passkeyConfirmed ? 'passkey' : 'nfc_pin'];
  if (managerTwoFactor) out.push('manager_2fa');
  return out;
}

/** «Más de 100 €», «el tope de la noche»…: por qué espera al encargado (para el aviso y la pantalla). */
export function payoutReasonText(reasons: readonly ReceptionPayoutReason[], limitCents: number, capCents: number): string {
  const parts: string[] = [];
  if (reasons.includes('over_limit')) parts.push(`más de ${eur(limitCents)}`);
  if (reasons.includes('night_cap')) parts.push(`pasa tu tope de la noche (${eur(capCents)})`);
  if (reasons.includes('no_passkey')) parts.push('su saldo tiene Face ID y no lo ha confirmado en su móvil');
  return parts.join(' y ');
}

/** Un candado por persona y local: dos salidas suyas a la vez no se saltan el tope de la noche. */
export async function lockReceptionNight(tx: Pick<TransactionalClient, '$queryRaw'>, tenantId: string, userId: string): Promise<void> {
  const key = `np:reception-payout:${tenantId}:${userId}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Lo que esta persona ha devuelto en efectivo en recepción esta noche (de las
 * 08:00 de Madrid): las salidas con NFC (llevan requestKey), hechas.
 */
export async function receptionNightPaidCents(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  tenantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ total: bigint | number | null }>>`
    SELECT COALESCE(SUM("amountCents"), 0)::bigint AS total
      FROM wallet_payouts
     WHERE "tenantId" = ${tenantId}::uuid
       AND "paidByUserId" = ${userId}::uuid
       AND method = 'CASH' AND status = 'DONE'
       AND "requestKey" IS NOT NULL
       AND "createdAt" >= ${lastNightCutoff(now)}
  `;
  return Number(rows[0]?.total ?? 0);
}

/** El registro que lleva a Incidencias («Recepción pasa su tope de la noche»). */
export const RECEPTION_PAYOUT_CAP_ACTION = 'wallet.reception_payout_cap';

/**
 * La primera vez que esta persona pasa su tope esta noche: al registro (en
 * la misma transacción, con el candado de su noche puesto) y de ahí a
 * Incidencias y a Telegram. Una por persona y noche.
 */
export async function capReachedFirstTime(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  tenantId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS found FROM audit_events
     WHERE action = ${RECEPTION_PAYOUT_CAP_ACTION}
       AND "tenantId" = ${tenantId}::uuid
       AND "actorId" = ${userId}::uuid
       AND "occurredAt" >= ${lastNightCutoff(now)}
     LIMIT 1
  `;
  return rows[0]?.found !== 1;
}

/**
 * Esta petición de devolver la dejó recepción para el encargado (más de 100 €,
 * su tope de la noche…): en el panel, el encargado la confirma con su 2FA
 * aunque sea poco. Mira la petición viva: desde que se pidió (con un margen,
 * el registro lleva la hora de su transacción).
 */
export async function receptionAskedManager(
  tx: Pick<TransactionalClient, '$queryRaw'>,
  walletId: string,
  closeRequestedAt: Date | null,
): Promise<boolean> {
  if (!closeRequestedAt) return false;
  const since = new Date(closeRequestedAt.getTime() - REQUEST_MARGIN_MS);
  const rows = await tx.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS found FROM audit_events
     WHERE action = 'wallet.close_requested'
       AND "targetType" = 'ClientWallet' AND "targetId" = ${walletId}
       AND payload ->> 'managerRequired' = 'true'
       AND "occurredAt" >= ${since}
     LIMIT 1
  `;
  return rows[0]?.found === 1;
}

const REQUEST_MARGIN_MS = 5 * 60 * 1000;

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
