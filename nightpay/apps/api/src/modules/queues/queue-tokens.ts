// Tokens de colas BullMQ — referenciar siempre desde aquí (no strings sueltos)
export const QR_EXPIRE_QUEUE = 'payments-lifecycle';
export const ORPHAN_RECONCILE_QUEUE = 'payments-reconcile';
export const WEBHOOKS_INGEST_QUEUE = 'webhooks-ingest';
// Conciliación diaria antigua (retirada): solo se usa para borrar sus trabajos.
export const RECONCILIATION_QUEUE = 'reconciliation-daily';
