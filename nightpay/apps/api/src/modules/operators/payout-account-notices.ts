import { ConflictException } from '@nestjs/common';
import { PAYOUT_ACCOUNT_TOO_NEW, holderMatchesName, maskPayoutAddress, type PayoutMethod } from '@nightpay/contracts';
import type { AuditInput } from '../audit/audit.service';
import { escapeHtml } from '../payments/club-ui';
import { accountForAudit, type OpenPayoutAccount } from './payout-account';

/**
 * Cuando cambia la cuenta de cobro de una compañera (panel, enlace de alta o
 * OxioPay): el registro (que Incidencias enseña como acción delicada y
 * Telegram avisa) y un correo a ella. En los dos, la cuenta va tapada. El
 * aviso de su app sale de users.payoutAccountChangedAt (getPayoutNotice).
 */

/** Por dónde cambió: el panel del dueño, su enlace de alta o la consola de OxioPay. */
export type PayoutChangeVia = 'panel' | 'enlace' | 'oxiopay';

const DAY = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long' });
const TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** «19 de noviembre a las 23:10» (hora de Madrid). */
export function madridWhen(d: Date): string {
  return `${DAY.format(d)} a las ${TIME.format(d)}`;
}

/**
 * «Marcar pagado» (o pedirlo) a una cuenta cambiada hace menos de 48 h: 409
 * con la fecha desde la que se puede. En efectivo, sí; por cualquier otra vía,
 * no (si no, bastaría elegir otro método para saltárselo). null si se puede.
 */
export function payoutAccountTooNew(
  person: { displayName?: string | null; payoutHoldUntil?: Date | null },
  rail: string | null,
  now: Date,
): ConflictException | null {
  const until = person.payoutHoldUntil;
  if (!until || until.getTime() <= now.getTime() || rail === 'MANUAL_CASH') return null;
  const name = person.displayName?.trim();
  return new ConflictException({
    code: PAYOUT_ACCOUNT_TOO_NEW,
    payableFrom: until.toISOString(),
    message:
      `${name ? `La cuenta de cobro de ${name}` : 'Esta cuenta de cobro'} cambió hace menos de 48 h: ` +
      `se le puede pagar a esa cuenta a partir del ${madridWhen(until)}. En efectivo, sí se le puede pagar ya.`,
  });
}

export interface PayoutChangedEmailInput {
  venueName: string;
  name: string | null;
  /** La cuenta nueva, tapada (null: efectivo o sin cuenta). */
  masked: string | null;
  method: PayoutMethod | null;
  at: Date;
  /** Desde cuándo se le paga a la cuenta nueva (null: ya). */
  holdUntil: Date | null;
}

export function payoutChangedEmail(input: PayoutChangedEmailInput): { subject: string; text: string; html: string } {
  const now = input.masked
    ? `Ahora te pagan a: ${input.masked}.`
    : input.method === 'MANUAL_CASH'
      ? 'Ahora cobras en efectivo.'
      : 'Ya no tienes cuenta de cobro: hasta que pongas otra, se te paga en efectivo.';
  const lines = [
    input.name?.trim() ? `Hola ${input.name.trim()},` : 'Hola,',
    `tu cuenta de cobro en ${input.venueName} ha cambiado el ${madridWhen(input.at)}.`,
    now,
    ...(input.holdUntil ? [`Por seguridad, los pagos a esta cuenta empiezan a partir del ${madridWhen(input.holdUntil)}.`] : []),
    'Si no lo has pedido tú, habla hoy mismo con el dueño del local.',
  ];
  return {
    subject: `Tu cuenta de cobro en ${input.venueName} ha cambiado`,
    text: lines.join('\n\n'),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n'),
  };
}

export interface PayoutChangeNotice {
  tenantId: string;
  /** Quien la cambió (el dueño, la propia compañera o el super-admin). */
  actorId: string;
  via: PayoutChangeVia;
  /** legalName en claro, si lo tiene: el titular se compara con él (y, si no coincide, el dueño lo confirma). */
  operator: { id: string; email: string; displayName: string | null; legalName?: string | null };
  venueName: string;
  before: OpenPayoutAccount;
  after: OpenPayoutAccount;
  at: Date;
  holdUntil: Date | null;
}

interface NoticeDeps {
  audit: { log: (entry: AuditInput) => Promise<unknown> };
  email: { send: (input: { to: string; subject: string; html: string; text?: string }) => Promise<unknown>; isEnabled: () => boolean };
  logger?: { error: (message: string) => void };
}

/**
 * Registro + correo. El registro va primero (si falla, el que llama se
 * entera: es lo que ve el dueño en Incidencias); el correo, si falla, solo se
 * apunta en el log (sin la cuenta).
 */
export async function notifyPayoutAccountChanged(deps: NoticeDeps, n: PayoutChangeNotice): Promise<void> {
  const name = n.operator.displayName?.trim() || null;
  const legalName = n.operator.legalName?.trim() || null;
  const holder = n.after.metadata?.accountHolder ?? null;
  const holderMismatch = holder ? !holderMatchesName(holder, legalName ?? name) : false;
  await deps.audit.log({
    action: 'operator.payout_account_changed',
    tenantId: n.tenantId,
    actorId: n.actorId,
    targetType: 'User',
    targetId: n.operator.id,
    payload: {
      via: n.via,
      name,
      before: accountForAudit(n.before),
      after: accountForAudit(n.after),
      holderMismatch,
      // Contra su nombre legal: no se le paga a esa cuenta hasta que el dueño confirme que es suya.
      holderToConfirm: holderMismatch && legalName !== null,
      holdUntil: n.holdUntil?.toISOString() ?? null,
      // Sin RESEND_API_KEY no sale el correo: la incidencia no lo promete. Un fallo de Resend, solo en el log.
      emailed: deps.email.isEnabled(),
    },
  });
  try {
    await deps.email.send({
      to: n.operator.email,
      ...payoutChangedEmail({
        venueName: n.venueName,
        name,
        masked: maskPayoutAddress(n.after.method, n.after.address),
        method: n.after.method,
        at: n.at,
        holdUntil: n.holdUntil,
      }),
    });
  } catch (err) {
    deps.logger?.error(`No se pudo mandar el aviso de cuenta de cobro a ${n.operator.id}: ${(err as Error).message}`);
  }
}
