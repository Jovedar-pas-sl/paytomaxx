import { setup, type AnyActorRef, createActor } from 'xstate';
import type { PaymentStatus } from '@nightpay/contracts';

/**
 * Máquina de estados del pago — ADR-003.
 *
 * Estados terminales: AUTHORIZED (con sub-flujo de refunds), FAILED, EXPIRED.
 * ORPHAN es resoluble (saga reconcile) — convierte a AUTHORIZED o FAILED.
 *
 * Las transiciones son DECLARATIVAS aquí: si un evento llega en estado
 * incorrecto, el actor NO transiciona y `transition()` lanza
 * `InvalidTransitionError`. Esto es la primera línea de defensa contra
 * webhooks desordenados o duplicados.
 */

export type PaymentEvent =
  | { type: 'QR_VIEWED' }
  | { type: 'AUTHORIZING' }
  | { type: 'AUTHORIZED'; providerTxId: string; provider: 'WIPAY' | 'PEANPE' | 'STRIPE' }
  | { type: 'FAILED'; reason: string }
  | { type: 'TIMEOUT' }
  | { type: 'REFUND_PARTIAL'; amountCents: number }
  | { type: 'REFUND_FULL' };

export interface PaymentContext {
  paymentId: string;
  amountCents: number;
  availableAmountCents: number;
  providerTxId?: string;
  provider?: 'WIPAY' | 'PEANPE' | 'STRIPE';
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
      if (event.type !== 'FAILED') return;
      context.failureReason = event.reason;
    },
    deductRefund: ({ context, event }) => {
      if (event.type !== 'REFUND_PARTIAL') return;
      context.availableAmountCents = Math.max(0, context.availableAmountCents - event.amountCents);
    },
  },
  guards: {
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
      },
    },
    AWAITING_CAPTURE: {
      on: {
        AUTHORIZING: 'AUTHORIZING',
        TIMEOUT: 'EXPIRED',
      },
    },
    AUTHORIZING: {
      on: {
        AUTHORIZED: { target: 'AUTHORIZED', actions: 'persistAuth' },
        FAILED: { target: 'FAILED', actions: 'persistFailure' },
        TIMEOUT: 'ORPHAN',
      },
    },
    AUTHORIZED: {
      on: {
        REFUND_PARTIAL: [
          { target: 'REFUNDED', guard: 'refundIsTotal', actions: 'deductRefund' },
          { target: 'PARTIALLY_REFUNDED', actions: 'deductRefund' },
        ],
        REFUND_FULL: 'REFUNDED',
      },
    },
    PARTIALLY_REFUNDED: {
      on: {
        REFUND_PARTIAL: [
          { target: 'REFUNDED', guard: 'refundIsTotal', actions: 'deductRefund' },
          { target: 'PARTIALLY_REFUNDED', actions: 'deductRefund' },
        ],
        REFUND_FULL: 'REFUNDED',
      },
    },
    ORPHAN: {
      on: {
        AUTHORIZED: { target: 'AUTHORIZED', actions: 'persistAuth' },
        FAILED: { target: 'FAILED', actions: 'persistFailure' },
      },
    },
    FAILED: { type: 'final' },
    EXPIRED: { type: 'final' },
    REFUNDED: { type: 'final' },
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
  | 'REFUNDED';

/**
 * Reconstruye un actor desde el estado persistido + contexto.
 * Si la transición no es válida, devuelve null y NO modifica el estado.
 */
export function applyEvent(
  currentState: PaymentStatus,
  context: PaymentContext,
  event: PaymentEvent,
): { nextState: PaymentMachineState; nextContext: PaymentContext } | null {
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
  constructor(state: PaymentStatus, eventType: string) {
    super(`Invalid FSM transition: cannot apply ${eventType} from state ${state}`);
    this.name = 'InvalidTransitionError';
  }
}
