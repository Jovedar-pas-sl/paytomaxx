// Pagar a una chica puede no pagar: si el local pide la aprobación del dueño
// para los pagos del encargado, el API responde 202 con la petición
// («Por aprobar») en vez del pago hecho.

/** Respuesta 202 de POST /v1/admin/operators/:id/payouts: pedido al dueño. */
export interface PayoutRequested {
  approvalRequestId: string;
  status: 'PENDING';
  amountCents: number;
  message: string;
}

/** ¿La respuesta es «pedido al dueño» (y no un pago hecho)? */
export function isPayoutRequested(body: unknown): body is PayoutRequested {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.approvalRequestId === 'string' &&
    b.status === 'PENDING' &&
    typeof b.amountCents === 'number' &&
    typeof b.message === 'string'
  );
}
