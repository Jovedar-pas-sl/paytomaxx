import { RETRY_WAIT_MS } from '@nightpay/contracts';
import { MAX_PAYMENT_ATTEMPTS, PAID_STATES, decideRedsysRetry } from './pay-redirect';
import type { PaymentMachineState } from './payment.machine';

/**
 * El estado de un pago para la página «Comprobando el pago» del cliente
 * (05-ui-ux §4): lo consulta su JavaScript (GET /pay/:token/status y
 * /pay/result/status?op=) y, al llegar a un estado final, recarga la página
 * del servidor (que pinta el «Pagado» con su cookie, el aviso o el cobro).
 *
 *  - open:        aún no ha ido al banco (la página del cobro le deja pagar);
 *  - processing:  esperando al banco (con cuándo salió y cuándo podrá reintentar);
 *  - paid:        pagado;
 *  - denied:      el banco lo denegó (puede probar con otra tarjeta);
 *  - unconfirmed: sin confirmación del banco (QR caducado con un intento sin
 *                 contestar u ORPHAN): pudo cobrarse, se sigue comprobando;
 *  - closed:      caducado, fallido, cancelado o sin más intentos (también el
 *                 cobro único pagado con el saldo: la tarjeta queda cancelada y
 *                 la página del servidor dice «Ya está pagado con tu saldo»).
 *
 * No da nada nuevo del cobro: ni su id, ni el pedido del banco, ni la tarjeta.
 */
export type PayStatusState = 'open' | 'processing' | 'paid' | 'denied' | 'unconfirmed' | 'closed';

export interface PayStatusView {
  state: PayStatusState;
  /** Cuándo salió el intento hacia el banco (la espera se cuenta desde ahí). */
  attemptStartedAt: string | null;
  /** Desde cuándo puede volver a intentarlo (misma regla que decideRedsysRetry); null: no podrá. */
  retryAt: string | null;
  qrExpiresAt: string;
  /** Lo que se cobra en el banco: importe + comisión del servicio + propina del intento. */
  amountCents: number;
  venueName: string | null;
  /** Otro navegador tiene el intento pendiente: «Alguien está pagando este cobro ahora mismo». */
  otherPayer: boolean;
  /** La hora del servidor (la página corrige con ella el reloj del móvil). */
  now: string;
}

export interface PayStatusInput {
  status: PaymentMachineState;
  provider: string | null;
  amountCents: number;
  serviceFeeCents: number;
  tipCents: number;
  qrExpiresAt: Date;
  updatedAt: Date;
  venueName: string | null;
  /** Intentos del cobro, del más reciente al más antiguo. */
  attempts: ReadonlyArray<{ status: string; createdAt: Date; claimHash: string | null; amountCents: number | null }>;
  /**
   * La huella de la cookie de este navegador (null: no tiene). undefined: no
   * se mira (la vuelta del banco, /pay/result, es de quien pagó).
   */
  viewerClaimHash?: string | null;
  /** /pay/result?op=: el estado de ESE intento (un DENIED es «denegado» aunque haya otro detrás). */
  ownAttemptStatus?: string | null;
  now: Date;
}

const CLOSED: ReadonlySet<PaymentMachineState> = new Set<PaymentMachineState>(['EXPIRED', 'FAILED', 'CANCELED']);

export function payStatusView(i: PayStatusInput): PayStatusView {
  const latest = i.attempts[0];
  const startedAt = (latest?.createdAt ?? i.updatedAt).toISOString();
  const view = (state: PayStatusState, extra: Partial<PayStatusView> = {}): PayStatusView => ({
    state,
    attemptStartedAt: null,
    retryAt: null,
    qrExpiresAt: i.qrExpiresAt.toISOString(),
    amountCents: latest?.amountCents ?? i.amountCents + i.serviceFeeCents + i.tipCents,
    venueName: i.venueName,
    otherPayer: false,
    now: i.now.toISOString(),
    ...extra,
  });

  if (PAID_STATES.has(i.status)) return view('paid');
  if (i.status === 'ORPHAN') return view('unconfirmed', { attemptStartedAt: startedAt });
  if (CLOSED.has(i.status)) return view('closed');
  if (i.status !== 'AUTHORIZING') return view(i.qrExpiresAt <= i.now ? 'closed' : 'open');

  // Esperando al banco.
  if (i.ownAttemptStatus === 'DENIED') return view('denied', { attemptStartedAt: startedAt });
  const otherPayer =
    i.viewerClaimHash !== undefined && latest?.status === 'PENDING' && Boolean(latest.claimHash) && latest.claimHash !== i.viewerClaimHash;
  // Otras pasarelas: se espera su aviso (no se abren pedidos nuevos desde aquí).
  if (i.provider !== 'REDSYS') return view('processing', { attemptStartedAt: startedAt, otherPayer });
  const decision = decideRedsysRetry({ attempts: i.attempts, now: i.now, qrExpiresAt: i.qrExpiresAt, paymentUpdatedAt: i.updatedAt });
  if (decision === 'unconfirmed') return view('unconfirmed', { attemptStartedAt: startedAt });
  if (decision === 'expired' || decision === 'max-attempts') return view('closed');
  if (decision === 'retry' && latest?.status === 'DENIED') return view('denied', { attemptStartedAt: startedAt });
  return view('processing', { attemptStartedAt: startedAt, retryAt: retryAtOf(i), otherPayer });
}

/**
 * Desde cuándo podrá volver a intentarlo: 2:30 después del intento sin
 * contestar (decideRedsysRetry), si aún le quedan intentos y el QR sigue
 * vigente entonces. Con el aviso aprobado (aún sin procesar), nunca.
 */
function retryAtOf(i: PayStatusInput): string | null {
  const latest = i.attempts[0];
  if (!latest || latest.status !== 'PENDING') return null;
  if (i.attempts.length >= MAX_PAYMENT_ATTEMPTS) return null;
  const at = latest.createdAt.getTime() + RETRY_WAIT_MS;
  if (at >= i.qrExpiresAt.getTime()) return null;
  return new Date(at).toISOString();
}
