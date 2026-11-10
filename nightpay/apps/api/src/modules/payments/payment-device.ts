import { randomUUID } from 'node:crypto';
import type { DeviceStep, DeviceWho } from '@nightpay/contracts';
import type { RequestContext } from '../../common/context/request-context';
import type { TransactionalClient } from '../../common/prisma/prisma.service';

/**
 * El dispositivo con el que se crea, se paga, se confirma o se cancela un
 * cobro (detalle del pago): un evento `payment.device` en la misma
 * transacción que ese paso. Sale del contexto de la petición
 * (RequestContext.device, del setup de CLS): sin él (trabajos, avisos del
 * banco), no se escribe nada.
 *
 * La IP se borra a los 90 días (device-ip-retention.ts): queda `ipErased`.
 * Los cobros del saldo sin cobro con tarjeta van al registro (audit_events)
 * SIN la IP: ahí no se puede borrar nada.
 */

export const PAYMENT_DEVICE_EVENT = 'payment.device';
/** La recarga sumada al saldo: el saldo antes y después (lo que ve el cliente en su detalle). */
export const WALLET_CREDITED_EVENT = 'payment.wallet_credited';
/** Un cobro del saldo pagado sin cobro con tarjeta enlazado (saldo suelto): en el registro, sin IP. */
export const WALLET_CHARGE_SETTLED_ACTION = 'wallet.charge_settled';
/** Un cobro del saldo suelto creado: el móvil del personal, en el registro y sin IP. */
export const WALLET_CHARGE_CREATED_ACTION = 'wallet.charge_created';

export interface DeviceEventExtra {
  /** Quién era, si no se deduce del contexto (con sesión: el personal). */
  who?: DeviceWho;
  attemptId?: string;
  walletChargeId?: string;
  authMethod?: string;
  /** Pagando con PIN: con qué se dijo de quién era el saldo (ficha, pase o código). */
  pinVia?: string;
  /** El saldo antes y después de pagar con él. */
  balanceBeforeCents?: number;
  balanceAfterCents?: number;
}

export interface PaymentDevicePayload extends DeviceEventExtra {
  who: DeviceWho;
  step: DeviceStep;
  userId?: string;
  model: string | null;
  os: string | null;
  osVersion: string | null;
  browser: string | null;
  mobile: boolean | null;
  inApp: string | null;
  /** Null: no se supo, o ya se borró (`ipErased`). */
  ip: string | null;
  ipErased?: boolean;
}

/**
 * De quién es el dispositivo: con sesión del personal, del personal; con un
 * local en el contexto y sin persona, del datáfono (su credencial); sin nada,
 * del cliente (las páginas /pay, /s, /w, /r).
 */
export function deviceWhoOf(ctx: Pick<RequestContext, 'userId' | 'tenantId'> | undefined): DeviceWho {
  if (ctx?.userId) return 'staff';
  if (ctx?.tenantId) return 'device';
  return 'client';
}

/**
 * El payload del evento, o null si la petición no trae dispositivo (sistema).
 * Con `evenWithoutDevice`, igual (con el dispositivo sin saber): para pasos
 * que guardan algo más, como el saldo antes y después.
 */
export function paymentDevicePayload(
  ctx: RequestContext | undefined,
  step: DeviceStep,
  extra: DeviceEventExtra = {},
  opts: { evenWithoutDevice?: boolean } = {},
): PaymentDevicePayload | null {
  const device = ctx?.device;
  if (!device && !opts.evenWithoutDevice) return null;
  const { who, ...rest } = extra;
  return {
    who: who ?? deviceWhoOf(ctx),
    step,
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...definedOnly(rest),
    model: device?.model ?? null,
    os: device?.os ?? null,
    osVersion: device?.osVersion ?? null,
    browser: device?.browser ?? null,
    mobile: device?.mobile ?? null,
    inApp: device?.inApp ?? null,
    ip: device?.ip ?? null,
  };
}

/** Para el registro (no se puede borrar): sin la IP. */
export function withoutIp(p: PaymentDevicePayload): Omit<PaymentDevicePayload, 'ip'> {
  const { ip: _ip, ...rest } = p;
  return rest;
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

type RawTx = Pick<TransactionalClient, '$executeRaw'>;

/**
 * Un evento del cobro en SQL crudo (como transition()): vale dentro de
 * cualquier transacción, con o sin local en el contexto.
 */
export async function insertPaymentEvent(
  tx: RawTx,
  e: { paymentId: string; tenantId: string; eventType: string; payload: object; traceId?: string | null },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO payment_events ("paymentId", "tenantId", "eventType", payload, "traceId")
    VALUES (${e.paymentId}::uuid, ${e.tenantId}::uuid, ${e.eventType}, ${JSON.stringify(e.payload)}::jsonb, ${e.traceId ?? randomUUID()})
  `;
}

/** El dispositivo de este paso, si la petición lo trae. Devuelve si lo escribió. */
export async function recordPaymentDevice(
  tx: RawTx,
  ctx: RequestContext | undefined,
  payment: { id: string; tenantId: string },
  step: DeviceStep,
  extra: DeviceEventExtra = {},
): Promise<boolean> {
  const payload = paymentDevicePayload(ctx, step, extra);
  if (!payload) return false;
  await insertPaymentEvent(tx, {
    paymentId: payment.id,
    tenantId: payment.tenantId,
    eventType: PAYMENT_DEVICE_EVENT,
    payload,
    traceId: ctx?.traceId,
  });
  return true;
}
