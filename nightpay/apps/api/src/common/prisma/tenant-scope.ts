/**
 * Modelos que requieren aislamiento por tenant_id: el middleware de
 * PrismaService les inyecta el local del contexto (CLS) en where/data.
 * Si añades un modelo con tenantId, agrégalo aquí o el middleware no lo protegerá.
 *
 * NO están (y no deben estar) los que cruzan locales por diseño o no tienen
 * local al llegar: ClientWallet, WalletConsumption, WalletPasskey, WalletCard,
 * WalletPushSubscription (el saldo vale en todo el grupo), WebhookDelivery y PeanpeCall (los avisos
 * del banco llegan sin local), AuditEvent (lo escribe el sistema con el local
 * explícito).
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'User',
  'Terminal',
  'GatewayCredential',
  'Payment',
  'PaymentEvent',
  'PaymentAttempt',
  'Refund',
  'Reconciliation',
  'OperatorEarning',
  'EarningReversal',
  'OperatorPayout',
  'ServiceItem',
  'ServiceItemImage',
  'UserPhoto',
  'VenueNight',
  'IncidentAck',
  'PosTerminalOp',
  'WalletChargeRequest',
  'WalletPayout',
  'WalletCashTopUp',
  'BankStatement',
  'BankStatementItem',
  'ApprovalRequest',
  'PaymentLine',
  'ChargeRefCounter',
  // «Liquidación OxioPay» (20261031100000): lo que el local debe a OxioPay y sus pagos.
  'OxioPaySettlement',
  'OxioPaySettlementPayment',
  // «Pagar con bitcoin»: la conexión del local a su BTCPay y sus facturas.
  'BtcpayStore',
  'BtcpayInvoice',
  // Bitcoin sin cobro devuelto en efectivo (20261117100100).
  'BtcCashReturn',
]);

// Operaciones de lectura a filtrar y de escritura a inyectar tenantId
const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const CREATE_MANY_OPS = new Set(['createMany', 'createManyAndReturn']);
const WHERE_WRITE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany']);

type Args = Record<string, unknown>;
interface QueryParams {
  action: string;
  args?: Args;
}

function withKey(args: Args, key: string, tenantId: string): Args {
  return { ...args, [key]: { ...((args[key] as Args | undefined) ?? {}), tenantId } };
}

/** Copia de la consulta limitada al local (no modifica la original). */
export function scopeToTenant<P extends QueryParams>(params: P, tenantId: string): P {
  const args = params.args ?? {};
  if (READ_OPS.has(params.action) || WHERE_WRITE_OPS.has(params.action)) {
    return { ...params, args: withKey(args, 'where', tenantId) };
  }
  if (params.action === 'create') return { ...params, args: withKey(args, 'data', tenantId) };
  if (params.action === 'upsert') {
    return { ...params, args: withKey(withKey(args, 'where', tenantId), 'create', tenantId) };
  }
  if (CREATE_MANY_OPS.has(params.action) && Array.isArray(args.data)) {
    return { ...params, args: { ...args, data: (args.data as Args[]).map((row) => ({ ...row, tenantId })) } };
  }
  return params;
}
