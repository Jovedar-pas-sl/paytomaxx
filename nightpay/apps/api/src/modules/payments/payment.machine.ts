import { setup, type AnyActorRef, createActor } from 'xstate';
import type { PaymentStatus } from '@nightpay/contracts';

/**
 * Máquina de estados del pago — ADR-003.
 *
 * Estados terminales: AUTHORIZED (con sub-flujo de refunds), EXPIRED,
 * CANCELED y REFUNDED. ORPHAN es resoluble (saga reconcile o a mano).
 *
 * FAILED NO es del todo final: si después llega la aprobación del banco
 * (el cliente reintentó en la página de la pasarela con el mismo pedido, o
 * el aviso aprobado llega tarde), el cobro pasa a AUTHORIZED. El dinero ya
 * está cobrado: perder ese aviso deja la tarjeta cargada y nada apuntado.
 *
 * Las transiciones son DECLARATIVAS aquí: si un evento llega en estado
 * incorrecto, el actor NO transiciona y `transition()` lanza
 * `InvalidTransitionError`. Esto es la primera línea de defensa contra
 * webhooks desordenados o duplicados.
 */

export type PaymentEvent =
  | { type: 'QR_VIEWED' }
  | { type: 'AUTHORIZING' }
  | { type: 'AUTHORIZED'; providerTxId: string; provider: 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | 'BTCPAY' }
  /**
   * POS confirmation event — camarero/manager confirma cobrado tras procesar
   * la tarjeta en el datáfono del bar. No hay PSP de NightPay involucrado,
   * por eso provider/providerTxId son nulos. Transición directa CREATED →
   * AUTHORIZED.
   */
  | { type: 'POS_CONFIRMED'; posReceiptRef?: string }
  | { type: 'FAILED'; reason: string }
  /**
   * La pasarela no pudo abrir el pago por un error definitivo (configuración,
   * datos rechazados) ANTES de ir al banco: CREATED|AWAITING_CAPTURE → FAILED.
   * Solo lo envía startAuthorization; un fallo pasajero no lo envía (el cobro
   * se queda como estaba y se puede reintentar). Con un intento ya en el
   * banco (AUTHORIZING) no vale: ese lo resuelven el aviso o la conciliación.
   */
  | { type: 'CHECKOUT_FAILED'; reason: string }
  | { type: 'TIMEOUT' }
  /**
   * Devolución (parcial o total): la total es la que deja el importe
   * devolvible a 0 (guard `refundIsTotal`). No hay evento aparte para la
   * total: REFUND_FULL no lo enviaba nadie y se quitó.
   */
  | { type: 'REFUND_PARTIAL'; amountCents: number }
  /** `byUserId`: quién lo canceló (el personal; los automáticos no lo llevan). */
  | { type: 'CANCELED'; reason?: string; byUserId?: string }
  /**
   * Cobro único (cobro-link.ts): el cliente lo pagó con su saldo (NFC, PIN o
   * Face ID) antes que con la tarjeta. El cobro con tarjeta se cancela y ya
   * no se puede autorizar, también si el cliente estaba en la página del
   * banco (AUTHORIZING) o sin confirmar (ORPHAN, FAILED): una aprobación que
   * llegue después se devuelve sola o queda en Incidencias.
   */
  | { type: 'PAID_WITH_SALDO'; walletChargeId: string }
  /**
   * La factura de bitcoin se cerró sin pagarse (caducó o BTCPay la invalidó):
   * AUTHORIZING → AWAITING_CAPTURE. El cobro sigue abierto para pagarlo de otra
   * forma. Solo con una factura de BTCPAY: con un banco de por medio no se
   * vuelve atrás (el cliente puede estar pagando).
   */
  | { type: 'INVOICE_CLOSED' };

export interface PaymentContext {
  paymentId: string;
  amountCents: number;
  availableAmountCents: number;
  providerTxId?: string;
  provider?: 'WIPAY' | 'PEANPE' | 'PAYTEF' | 'REDSYS' | 'BTCPAY';
  failureReason?: string;
}

export const paymentMachine = setup({
  types: {} as {
    context: PaymentContext;
    events: PaymentEvent;
  },
  actions: {
    persistAuth: ({ context, event }) => {
      if (event.type !== 'AUTHORIZED') return;
      context.providerTxId = event.providerTxId;
      context.provider = event.provider;
    },
    persistFailure: ({ context, event }) => {
      if (event.type !== 'FAILED' && event.type !== 'CHECKOUT_FAILED') return;
      context.failureReason = event.reason;
    },
    persistCancel: ({ context, event }) => {
      if (event.type !== 'CANCELED') return;
      context.failureReason = event.reason ?? 'user-canceled';
    },
    persistPaidWithSaldo: ({ context, event }) => {
      if (event.type !== 'PAID_WITH_SALDO') return;
      context.failureReason = 'paid-with-saldo';
    },
    persistInvoiceClosed: ({ context }) => {
      context.failureReason = 'bitcoin-invoice-closed';
    },
    deductRefund: ({ context, event }) => {
      if (event.type !== 'REFUND_PARTIAL') return;
      context.availableAmountCents = Math.max(0, context.availableAmountCents - event.amountCents);
    },
  },
  guards: {
    // La factura de bitcoin es lo único que se abre y se cierra sin banco de por medio.
    isBitcoinPayment: ({ context }) => context.provider === 'BTCPAY',
    refundIsTotal: ({ context, event }) => {
      if (event.type !== 'REFUND_PARTIAL') return false;
      return context.availableAmountCents - event.amountCents <= 0;
    },
  },
}).createMachine({
  id: 'payment',
  initial: 'CREATED',
  context: {
    paymentId: '',
    amountCents: 0,
    availableAmountCents: 0,
  },
  states: {
    CREATED: {
      on: {
        QR_VIEWED: 'AWAITING_CAPTURE',
        TIMEOUT: 'EXPIRED',
        AUTHORIZING: 'AUTHORIZING',
        CHECKOUT_FAILED: { target: 'FAILED', actions: 'persistFailure' },
        // POS flow: camarero confirma cobrado en datáfono externo → AUTHORIZED
        // directo (sin AUTHORIZING porque no hay roundtrip al PSP).
        POS_CONFIRMED: 'AUTHORIZED',
        CANCELED: { target: 'CANCELED', actions: 'persistCancel' },
        PAID_WITH_SALDO: { target: 'CANCELED', actions: 'persistPaidWithSaldo' },
      },
    },
    AWAITING_CAPTURE: {
      on: {
        AUTHORIZING: 'AUTHORIZING',
        CHECKOUT_FAILED: { target: 'FAILED', actions: 'persistFailure' },
        TIMEOUT: 'EXPIRED',
        CANCELED: { target: 'CANCELED', actions: 'persistCancel' },
        PAID_WITH_SALDO: { target: 'CANCELED', actions: 'persistPaidWithSaldo' },
      },
    },
    AUTHORIZING: {
      on: {
        AUTHORIZED: { target: 'AUTHORIZED', actions: 'persistAuth' },
        FAILED: { target: 'FAILED', actions: 'persistFailure' },
        TIMEOUT: 'ORPHAN',
        PAID_WITH_SALDO: { target: 'CANCELED', actions: 'persistPaidWithSaldo' },
        // Bitcoin: el personal cancela el cobro y el cobro vuelve a estar abierto si la factura se cierra.
        CANCELED: { target: 'CANCELED', guard: 'isBitcoinPayment', actions: 'persistCancel' },
        INVOICE_CLOSED: { target: 'AWAITING_CAPTURE', guard: 'isBitcoinPayment', actions: 'persistInvoiceClosed' },
      },
    },
    AUTHORIZED: {
      on: {
        REFUND_PARTIAL: [
          { target: 'REFUNDED', guard: 'refundIsTotal', actions: 'deductRefund' },
          { target: 'PARTIALLY_REFUNDED', actions: 'deductRefund' },
        ],
      },
    },
    PARTIALLY_REFUNDED: {
      on: {
        REFUND_PARTIAL: [
          { target: 'REFUNDED', guard: 'refundIsTotal', actions: 'deductRefund' },
          { target: 'PARTIALLY_REFUNDED', actions: 'deductRefund' },
        ],
      },
    },
    ORPHAN: {
      on: {
        AUTHORIZED: { target: 'AUTHORIZED', actions: 'persistAuth' },
        FAILED: { target: 'FAILED', actions: 'persistFailure' },
        PAID_WITH_SALDO: { target: 'CANCELED', actions: 'persistPaidWithSaldo' },
      },
    },
    // Aprobación del banco tras un FAILED (denegación previa, aviso tardío o
    // resolución a mano equivocada): el cobro se apunta. Solo AUTHORIZED
    // saca un pago de FAILED; quien lo emite (aviso verificado, conciliación
    // con la pasarela) ya ha comprobado la aprobación.
    FAILED: {
      on: {
        AUTHORIZED: { target: 'AUTHORIZED', actions: 'persistAuth' },
        PAID_WITH_SALDO: { target: 'CANCELED', actions: 'persistPaidWithSaldo' },
      },
    },
    EXPIRED: { type: 'final' },
    REFUNDED: { type: 'final' },
    CANCELED: { type: 'final' },
  },
});

export type PaymentMachineState =
  | 'CREATED'
  | 'AWAITING_CAPTURE'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'PARTIALLY_REFUNDED'
  | 'ORPHAN'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'CANCELED';

/**
 * Reconstruye un actor desde el estado persistido + contexto.
 * Si la transición no es válida, devuelve null y NO modifica el estado.
 */
export function applyEvent(
  currentState: PaymentStatus,
  context: PaymentContext,
  event: PaymentEvent,
): { nextState: PaymentMachineState; nextContext: PaymentContext } | null {
  // Nunca se devuelve más de lo que queda por devolver (antes se recortaba a 0
  // en silencio: dos devoluciones a la vez podían sumar más que lo cobrado).
  if (
    event.type === 'REFUND_PARTIAL' &&
    (event.amountCents <= 0 || event.amountCents > context.availableAmountCents)
  ) {
    return null;
  }
  const actor: AnyActorRef = createActor(paymentMachine, {
    snapshot: paymentMachine.resolveState({ value: currentState, context }),
  });
  actor.start();

  const before = actor.getSnapshot();
  actor.send(event);
  const after = actor.getSnapshot();

  // Si el estado no cambió Y el evento no es self-transition válido → rechazar
  if (after.value === before.value && !isSelfTransition(currentState, event)) {
    actor.stop();
    return null;
  }

  const result = {
    nextState: after.value as PaymentMachineState,
    nextContext: after.context,
  };
  actor.stop();
  return result;
}

function isSelfTransition(state: PaymentStatus, event: PaymentEvent): boolean {
  // PARTIALLY_REFUNDED → PARTIALLY_REFUNDED por refund parcial sucesivo es válido
  return state === 'PARTIALLY_REFUNDED' && event.type === 'REFUND_PARTIAL';
}

export class InvalidTransitionError extends Error {
  readonly fromState: PaymentStatus;
  readonly eventType: string;

  constructor(state: PaymentStatus, eventType: string) {
    super(`Invalid FSM transition: cannot apply ${eventType} from state ${state}`);
    this.name = 'InvalidTransitionError';
    this.fromState = state;
    this.eventType = eventType;
  }
}

/** Estados en los que el cobro ya se hizo (aunque luego se haya devuelto). */
const PAID_STATES: ReadonlySet<string> = new Set(['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

/**
 * Distingue: ¿la transición fue rechazada porque el pago YA está en el
 * estado destino (idempotencia válida, OK) o porque está en un estado
 * incompatible (bug real, no debería marcarse como procesado)?
 *
 * Ej. webhook AUTHORIZED llega cuando payment ya está AUTHORIZED → idempotente.
 *     webhook AUTHORIZED llega cuando payment está EXPIRED → NO idempotente:
 *     el banco cobró un pago que aquí no se puede dar por pagado. Quien
 *     procesa el aviso lo apunta como incidencia (no se pierde en silencio).
 */
export function isIdempotentTransition(
  err: InvalidTransitionError,
): boolean {
  // Estados terminales o de éxito recibiendo el mismo evento = idempotente
  if (err.fromState === 'AUTHORIZED' && err.eventType === 'AUTHORIZED') return true;
  if (err.fromState === 'FAILED' && err.eventType === 'FAILED') return true;
  // PARTIALLY_REFUNDED ya implica AUTHORIZED previo — recibir AUTHORIZED tardío OK
  if (err.fromState === 'PARTIALLY_REFUNDED' && err.eventType === 'AUTHORIZED') return true;
  // REFUNDED igual — el cobro original sí ocurrió
  if (err.fromState === 'REFUNDED' && err.eventType === 'AUTHORIZED') return true;
  // Denegación que llega después de la aprobación (aviso viejo): el cobro
  // ya está hecho y una denegación anterior no lo deshace.
  if (PAID_STATES.has(err.fromState) && err.eventType === 'FAILED') return true;
  // EXPIRED / CANCELED son terminales: un evento tardío es info-only — salvo
  // una aprobación del banco, que es dinero cobrado y no se puede ignorar.
  if (err.fromState === 'EXPIRED' || err.fromState === 'CANCELED') {
    return err.eventType !== 'AUTHORIZED';
  }
  return false;
}
