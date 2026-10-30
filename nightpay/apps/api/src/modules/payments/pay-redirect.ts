import { RETRY_WAIT_MS } from '@nightpay/contracts';
import type { PayLanguage } from './customer-lang';
import type { PaymentMachineState } from './payment.machine';
import { maxTipCents, tipOptionsFor, type TipPresetConfig } from './tip';

/** Por qué un QR ya no se puede pagar (texto para el cliente en public-pay). */
export type PayClosedReason =
  | 'expired'
  | 'failed'
  | 'canceled'
  | 'unconfirmed'
  | 'too-many-attempts'
  /** Cobro único: ya lo pagó con su saldo (NFC, PIN o Face ID): la tarjeta no. */
  | 'paid-with-saldo';

/** Botón que pulsa el cliente: Apple Pay / Google Pay o tarjeta. */
export type PayMethodChoice = 'wallet' | 'card';

/** Lo que elige el cliente en la página de pago antes de ir al banco. */
export interface CheckoutChoice {
  tipCents: number;
  method: PayMethodChoice | null;
  language: PayLanguage;
  /** Huella de la cookie del navegador que abre el intento (enlace del saldo). */
  claimHash?: string | null;
}

export type PayRedirect =
  | { kind: 'redirect'; url: string; status: PaymentMachineState }
  | {
      kind: 'form';
      action: string;
      method: 'POST';
      fields: Record<string, string>;
      status: PaymentMachineState;
    }
  | {
      /**
       * Pedido abierto: el controlador redirige (303) a /pay/:token/checkout,
       * que pinta el formulario hacia el banco. Así "atrás" o recargar no
       * reenvían el POST de la página de pago.
       */
      kind: 'checkout';
      order: string;
    }
  | {
      /** Página de pago: importe, propina y botones. Aún no hay nada en el banco. */
      kind: 'choose';
      amountCents: number;
      /** «Comisión del servicio» encima del importe (0 sin ella): Consumo · Comisión · Propina · Total. */
      serviceFeeCents?: number;
      /** Su % (en bps) para «¿Qué es?» (el que se fijó al crear el cobro; null sin ella). */
      serviceFeeBps?: number | null;
      /** Una recarga del saldo: el importe es «Recarga», no «Consumo». */
      topUp?: boolean;
      currency: string;
      /** Propinas con botón (0 = «Sin propina», que es la marcada). */
      tipOptionsCents: number[];
      /** Máximo de «Otra» (0 = aquí no se puede dejar propina). */
      tipMaxCents: number;
      tipCents: number;
      qrExpiresAt: Date;
      /** Cabecera: nombre del local y concepto del cobro (si lo hay). */
      venueName?: string | null;
      concept?: string | null;
      /** La propina va entera a una persona del personal (no al local). */
      tipToStaff?: boolean;
      /** Propinas sugeridas del local (para enseñar el % de cada botón). */
      tipPresets?: TipPresetConfig;
      /**
       * Cobro único: el enlace del mismo cobro para pagarlo con el saldo
       * OxioCard desbloqueando el móvil (/s/<token>). Null: solo tarjeta.
       */
      saldoPayToken?: string | null;
      /**
       * Cobro único con la propina que pidió el cliente al personal (la
       * loseta «Propina»): sale ya marcada (la puede quitar). Sin ella, «Sin
       * propina» marcada, como siempre.
       */
      presetTipCents?: number;
    }
  | {
      kind: 'paid';
      paymentId: string;
      amountCents: number;
      tipCents: number;
      /** «Comisión del servicio» que pagó (0 sin ella). */
      serviceFeeCents?: number;
      currency: string;
      authorizedAt: Date | null;
      /** Recarga de saldo: enlace a la página del saldo del cliente. */
      walletToken: string | null;
      /** Huella del navegador que hizo el pago aprobado (solo él ve el enlace). */
      walletClaimHash: string | null;
      walletCode: string | null;
      walletHasFaceId: boolean;
      walletHasPin: boolean;
      /** Recarga empezada en /w: a qué saldo vuelve el navegador que la empezó. */
      walletReturnToken?: string | null;
      /** Saldo nuevo cargado desde casa: el navegador que pagó va a su saldo (con la bienvenida). */
      walletFromHome?: boolean;
      /** Huella del navegador del intento aprobado (solo él ve el «Pagado» lima). */
      approvedClaimHash?: string | null;
    }
  | { kind: 'processing' }
  | { kind: 'closed'; reason: PayClosedReason };

export interface PayResultView {
  paymentId: string;
  status: PaymentMachineState;
  amountCents: number;
  tipCents: number;
  /** «Comisión del servicio» del cobro (0 sin ella). */
  serviceFeeCents?: number;
  currency: string;
  authorizedAt: Date | null;
  qrToken: string;
  /** Recarga de saldo: token de la página del saldo del cliente. */
  walletToken: string | null;
  /** Huella del navegador que hizo el pago aprobado (solo él ve el enlace). */
  walletClaimHash: string | null;
  /** Recarga que creó el saldo: su código (K7Q-4M2) y si ya tiene Face ID. */
  walletCode: string | null;
  walletHasFaceId: boolean;
  walletHasPin: boolean;
  /** Recarga empezada en /w: a qué saldo vuelve (walletClaimHash = su cookie de vuelta). */
  walletReturnToken?: string | null;
  /** Saldo nuevo cargado desde casa: el navegador que pagó va a su saldo (con la bienvenida). */
  walletFromHome?: boolean;
  /** Estado del intento concreto por el que vuelve el cliente (PENDING/APPROVED/DENIED). */
  attemptStatus: string | null;
  /** Huella del navegador del intento aprobado (solo él ve el «Pagado» lima). */
  approvedClaimHash?: string | null;
}

/** Justificante del cliente: sin datos personales (ni nombre ni dígitos de tarjeta). */
export interface PayReceiptView {
  paymentId: string;
  amountCents: number;
  tipCents: number;
  /** «Comisión del servicio» que pagó (0 sin ella): una línea en el justificante. */
  serviceFeeCents?: number;
  /** Una recarga del saldo (el importe es «Recarga»). */
  topUp?: boolean;
  currency: string;
  authorizedAt: Date | null;
  authCode: string | null;
  cardBrand: string | null;
  payMethod: PayMethodChoice | null;
  /** Pedido del banco (Ds_Order) del intento cobrado. */
  order: string | null;
}

export const PAID_STATES: ReadonlySet<PaymentMachineState> = new Set<PaymentMachineState>([
  'AUTHORIZED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

export const CLOSED_REASON: Partial<Record<PaymentMachineState, PayClosedReason>> = {
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELED: 'canceled',
  ORPHAN: 'unconfirmed',
};

/** Intentos de pago (pedidos Redsys) por QR. */
export const MAX_PAYMENT_ATTEMPTS = 3;

/**
 * Tiempo que se espera al aviso del banco antes de dar por abandonado un
 * intento sin respuesta (2:30). Las denegaciones llegan al momento (y permiten
 * reintentar ya); esto solo cuenta cuando no llega nada, y tiene que cubrir
 * a un cliente que sigue en la pantalla de 3D Secure de su banco para no
 * abrir un segundo pedido que también pudiera pagarse. Vive en
 * @nightpay/contracts (pay-wait): el personal cuenta con el mismo.
 */
export { RETRY_WAIT_MS };

export type RetryDecision = 'retry' | 'wait' | 'expired' | 'unconfirmed' | 'max-attempts';

/**
 * Pago en AUTHORIZING por Redsys y el cliente vuelve a escanear el QR.
 *  - Último intento aprobado (aviso aún sin procesar) o pendiente reciente → esperar
 *    (salvo `switchingMethod`: pide otro botón, ver switchesMethod).
 *  - Denegado o abandonado → nuevo intento, si el QR sigue vigente y quedan intentos.
 *  - QR caducado: «sin confirmar» si algún intento sigue sin respuesta del banco
 *    (puede que sí cobrara: 3D Secure lento o aviso perdido), nunca «no se te ha
 *    cobrado nada»; «caducado» solo si todos están contestados.
 * `attempts` va del más reciente al más antiguo. Sin intentos registrados
 * (pagos anteriores a Fase 0) cuenta como uno pendiente desde `paymentUpdatedAt`.
 */
export function decideRedsysRetry(args: {
  attempts: ReadonlyArray<{ status: string; createdAt: Date }>;
  now: Date;
  qrExpiresAt: Date;
  paymentUpdatedAt: Date;
  /** El cliente pulsó otro botón que el del intento pendiente: no se le hace esperar. */
  switchingMethod?: boolean;
}): RetryDecision {
  const latest = args.attempts[0];
  const latestStatus = latest?.status ?? 'PENDING';
  const latestAt = latest?.createdAt ?? args.paymentUpdatedAt;
  const count = Math.max(args.attempts.length, 1);

  if (latestStatus === 'APPROVED') return 'wait';
  const recent = args.now.getTime() - latestAt.getTime() < RETRY_WAIT_MS;
  if (latestStatus === 'PENDING' && recent && !args.switchingMethod) return 'wait';
  if (args.qrExpiresAt <= args.now) return hasUnansweredAttempt(args.attempts) ? 'unconfirmed' : 'expired';
  if (count >= MAX_PAYMENT_ATTEMPTS) return 'max-attempts';
  return 'retry';
}

/** Algún pedido sin respuesta del banco (o ninguno registrado: pagos anteriores a Fase 0). */
function hasUnansweredAttempt(attempts: ReadonlyArray<{ status: string }>): boolean {
  return attempts.length === 0 || attempts.some((a) => a.status === 'PENDING');
}

/**
 * El cliente pulsa un botón distinto del que abrió el intento pendiente (p.
 * ej. «Pagar con tarjeta» tras cerrar la hoja de Apple Pay): se abre un
 * pedido nuevo con ese método en vez de devolverle el mismo o hacerle esperar
 * 2,5 min. Si los dos se acaban cobrando, es el doble cobro de siempre
 * (second-approval: incidencia y se devuelve uno). Un intento sin preferencia
 * (el banco enseña todos los métodos) ya sirve para cualquiera: no cuenta.
 */
export function switchesMethod(
  latest: { status: string; payMethod?: string | null } | undefined,
  method: PayMethodChoice | null,
): boolean {
  const pending = latest?.status === 'PENDING' ? (latest.payMethod ?? null) : null;
  return pending !== null && method !== null && pending !== method;
}

/** Lo que hace falta del cobro para decidir qué página ve el cliente. */
export interface PayablePayment {
  id: string;
  status: PaymentMachineState;
  amountCents: number;
  tipCents: number;
  /** «Comisión del servicio» fijada al crear el cobro (0 sin ella o en los de antes). */
  serviceFeeCents?: number;
  /** Su % (bps) del momento del cobro: solo para explicarla en la página. */
  serviceFeeBps?: number | null;
  /** Una recarga del saldo. */
  topUp?: boolean;
  currency: string;
  qrExpiresAt: Date;
  authorizedAt: Date | null;
  /** Propina solo con Redsys, fuera de recargas de wallet y con las propinas encendidas en el local. */
  allowTip: boolean;
  /** Propinas sugeridas del local (Ajustes); sin ellas, las de siempre. */
  tipPresets?: TipPresetConfig;
  /** Nombre del local y concepto del cobro, para la cabecera de la página de pago. */
  venueName?: string | null;
  concept?: string | null;
  /** La propina va entera a una persona del personal (no al local). */
  tipToStaff?: boolean;
  /** Recarga de saldo: token de la página del saldo del cliente. */
  walletToken: string | null;
  /** Huella del navegador que hizo el pago aprobado. */
  walletClaimHash: string | null;
  /** Recarga que creó el saldo: su código (K7Q-4M2) y si ya tiene Face ID. */
  walletCode: string | null;
  walletHasFaceId: boolean;
  walletHasPin: boolean;
  /**
   * Recarga empezada por el cliente en su página del saldo (/w): a ese saldo
   * vuelve tras pagar, solo el navegador que la empezó (walletClaimHash es la
   * huella de su cookie de vuelta). Entonces walletToken va a null: esa recarga
   * no da el código ni el Face ID a quien la paga.
   */
  walletReturnToken?: string | null;
  /**
   * La recarga que creó el saldo desde el enlace del local («Cargar saldo
   * antes de llegar»): tras pagar, el navegador que pagó (walletClaimHash) va
   * a la página de su saldo nuevo con la bienvenida, en vez del «Pagado».
   */
  walletFromHome?: boolean;
  /** Huella del navegador del intento aprobado (de cualquier cobro, con o sin saldo). */
  approvedClaimHash?: string | null;
  /**
   * Cobro único: el cobro del saldo enlazado (su enlace /s, su estado y su
   * plazo) y si el local cobra con saldo. Sin él, solo tarjeta.
   */
  saldo?: { payToken: string | null; status: string; expiresAt: Date; enabled: boolean } | null;
}

/**
 * Cobros que ya no van al banco: pagado, cerrado o QR caducado sin empezar.
 * `null` = se puede pagar (o hay un intento en curso).
 */
export function settledPayView(p: PayablePayment, now: Date = new Date()): PayRedirect | null {
  if (PAID_STATES.has(p.status)) {
    return {
      kind: 'paid',
      paymentId: p.id,
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      serviceFeeCents: p.serviceFeeCents ?? 0,
      currency: p.currency,
      authorizedAt: p.authorizedAt,
      walletToken: p.walletToken,
      walletClaimHash: p.walletClaimHash,
      walletCode: p.walletCode,
      walletHasFaceId: p.walletHasFaceId,
      walletHasPin: p.walletHasPin,
      ...(p.walletReturnToken ? { walletReturnToken: p.walletReturnToken } : {}),
      ...(p.walletFromHome ? { walletFromHome: true } : {}),
      approvedClaimHash: p.approvedClaimHash ?? null,
    };
  }
  // Cobro único: lo pagó el saldo (el cobro con tarjeta se canceló entonces).
  if (p.status === 'CANCELED' && p.saldo?.status === 'ACCEPTED') return { kind: 'closed', reason: 'paid-with-saldo' };
  const closed = CLOSED_REASON[p.status];
  if (closed) return { kind: 'closed', reason: closed };
  if (p.status !== 'AUTHORIZING' && p.qrExpiresAt <= now) return { kind: 'closed', reason: 'expired' };
  return null;
}

/**
 * Cobro único: el enlace para pagarlo con el saldo, si se puede (pendiente,
 * sin caducar y con el saldo encendido en el local).
 */
export function saldoPayTokenOf(p: Pick<PayablePayment, 'saldo'>, now: Date = new Date()): string | null {
  const s = p.saldo;
  if (!s || !s.enabled || !s.payToken || s.status !== 'PENDING' || s.expiresAt <= now) return null;
  return s.payToken;
}

/** Página de pago con las propinas que se pueden elegir. */
export function choosePayPage(p: PayablePayment, now: Date = new Date()): PayRedirect {
  const saldoPayToken = saldoPayTokenOf(p, now);
  return {
    kind: 'choose',
    amountCents: p.amountCents,
    serviceFeeCents: p.serviceFeeCents ?? 0,
    // Su % (para «¿Qué es?»), solo si hay comisión.
    ...((p.serviceFeeCents ?? 0) > 0 && p.serviceFeeBps ? { serviceFeeBps: p.serviceFeeBps } : {}),
    topUp: p.topUp ?? false,
    currency: p.currency,
    tipOptionsCents: tipOptionsFor(p),
    tipMaxCents: p.allowTip ? maxTipCents(p.amountCents) : 0,
    tipCents: p.tipCents,
    qrExpiresAt: p.qrExpiresAt,
    venueName: p.venueName ?? null,
    concept: p.concept ?? null,
    tipToStaff: p.tipToStaff ?? false,
    ...(p.tipPresets ? { tipPresets: p.tipPresets } : {}),
    ...(saldoPayToken ? { saldoPayToken } : {}),
    ...(p.saldo && p.allowTip && p.tipCents > 0 ? { presetTipCents: p.tipCents } : {}),
  };
}

/**
 * Un pedido recién abierto se puede volver a enseñar durante este tiempo: un
 * doble toque o el paso del POST al formulario llevan al mismo pedido en vez
 * de abrir otro. Pasado, "atrás" vuelve a la página del cobro.
 */
export const CHECKOUT_REPLAY_MS = 30_000;

/**
 * Pedido del último intento si sigue pendiente y es reciente. `attempts` va
 * del más reciente al más antiguo.
 */
export function freshPendingOrder(
  attempts: ReadonlyArray<{ providerTxId: string; status: string; createdAt: Date; claimHash?: string | null }>,
  now: Date,
  /**
   * Navegador que pide el formulario. Si se indica, solo se reutiliza su
   * propio pedido: otro navegador con el mismo QR no se queda con él.
   */
  claimHash?: string | null,
): string | null {
  const latest = attempts[0];
  if (!latest || latest.status !== 'PENDING') return null;
  if (claimHash !== undefined && (latest.claimHash ?? null) !== claimHash) return null;
  return now.getTime() - latest.createdAt.getTime() < CHECKOUT_REPLAY_MS ? latest.providerTxId : null;
}

/** Qué ve el cliente cuando no toca abrir un intento nuevo. */
export function retryOutcome(decision: Exclude<RetryDecision, 'retry'>): PayRedirect {
  if (decision === 'wait') return { kind: 'processing' };
  if (decision === 'unconfirmed') return { kind: 'closed', reason: 'unconfirmed' };
  return { kind: 'closed', reason: decision === 'expired' ? 'expired' : 'too-many-attempts' };
}

/**
 * Código corto que ven a la vez el cliente (pantalla "Pagado") y el personal
 * (su app, el TPV). Una sola función para el API y las apps (contracts).
 */
export { confirmationCode } from '@nightpay/contracts';
