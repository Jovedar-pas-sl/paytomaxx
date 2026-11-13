import { Prisma } from '@nightpay/db';

/**
 * RLS en la base (ADR-002). Las políticas de todas las tablas por local son
 * `app_rls_bypass() OR "tenantId" = app_current_tenant()`, con:
 *  - app_current_tenant() = el GUC `app.current_tenant_id` de la sesión;
 *  - app_rls_bypass()     = el GUC `app.bypass_rls` = 'on'.
 *
 * Estas tablas tienen FORCE ROW LEVEL SECURITY: las políticas valen
 * también para el DUEÑO de las tablas. Con un rol sin superusuario (el de
 * producción a partir de docs/DB-ROLE.md), una consulta a ellas sin el local
 * en la sesión ni el bypass no ve ninguna fila (y un INSERT falla). Por eso
 * solo se tocan dentro de una transacción de PrismaService: withTenant (local
 * en la sesión), asSystem / acrossVenues (bypass) o $transaction (pone el
 * local del contexto). El resto de tablas tienen RLS sin FORCE: el dueño no
 * pasa por las políticas.
 */
export const TENANT_GUC = 'app.current_tenant_id';

export const FORCED_RLS_TABLES = [
  'client_wallets',
  'wallet_consumptions',
  'operator_earnings',
  'operator_payouts',
  'earning_reversals',
  'peanpe_calls',
  // «Por aprobar» (20261016300000): una fila es un permiso para mover dinero.
  'approval_requests',
  // Efectivo que entra en los saldos (20261021200000): es dinero de la caja del local.
  'wallet_cash_topups',
  // El mapa del dinero (20261023100000): las líneas de cada cobro y el contador de su referencia.
  'payment_lines',
  'charge_ref_counters',
  // «Liquidación OxioPay» (20261031100000): lo que cada local debe a OxioPay y lo que ha pagado.
  'oxiopay_settlements',
  'oxiopay_settlement_payments',
  // El logo o la foto de cada producto de la carta (20261111100000).
  'service_item_images',
  // «Pagar con bitcoin» (20261114100100): la conexión del local a su BTCPay (con la clave cifrada) y sus facturas.
  'btcpay_stores',
  'btcpay_invoices',
  // La foto de perfil del personal (20261113100000).
  'user_photos',
  // OxioParty (20261115100000): las casetas, con la parte del organizador y su IBAN.
  'stalls',
] as const;

export const FORCED_RLS_MODELS: ReadonlySet<string> = new Set([
  'ClientWallet',
  'WalletConsumption',
  'OperatorEarning',
  'OperatorPayout',
  'EarningReversal',
  'PeanpeCall',
  'ApprovalRequest',
  'WalletCashTopUp',
  'PaymentLine',
  'ChargeRefCounter',
  'OxioPaySettlement',
  'OxioPaySettlementPayment',
  'ServiceItemImage',
  'BtcpayStore',
  'BtcpayInvoice',
  'UserPhoto',
  'Stall',
]);

const FORCED_TABLE_RE = new RegExp(`\\b(${FORCED_RLS_TABLES.join('|')})\\b`);

/** El SQL de una consulta cruda tal como llega al middleware de Prisma. */
export function rawSqlText(args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return '';
  const first: unknown = args[0];
  if (typeof first === 'string') return first; // $queryRawUnsafe / $executeRawUnsafe
  if (Array.isArray(first)) return first.join(' '); // plantilla: las partes de texto
  return '';
}

/** Primera tabla con FORCE RLS que nombra el SQL (o null). */
export function forcedTableIn(sql: string): string | null {
  return FORCED_TABLE_RE.exec(sql)?.[1] ?? null;
}

interface ModelFields {
  relations: Map<string, string>;
  scalars: Set<string>;
}

/** Relaciones y campos de cada modelo, del esquema que genera Prisma. */
function readDatamodel(): Map<string, ModelFields> {
  const out = new Map<string, ModelFields>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const relations = new Map<string, string>();
    const scalars = new Set<string>();
    for (const f of model.fields) {
      if (f.kind === 'object') relations.set(f.name, f.type);
      else scalars.add(f.name);
    }
    out.set(model.name, { relations, scalars });
  }
  return out;
}

let datamodel: Map<string, ModelFields> | null = null;
function fieldsOf(model: string): ModelFields | undefined {
  datamodel ??= readDatamodel();
  return datamodel.get(model);
}

const MAX_DEPTH = 12;

/**
 * La consulta llega a una tabla con FORCE RLS a través de una relación
 * (include, select, _count, filtros o escrituras anidadas). Recorre los
 * argumentos siguiendo el modelo de cada relación; no entra en los campos
 * escalares (filtros, JSON).
 */
function argsReachForced(model: string, value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => argsReachForced(model, v, depth + 1));
  if (value instanceof Date || Buffer.isBuffer(value)) return false;
  const fields = fieldsOf(model);
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const target = fields?.relations.get(key);
    if (target) {
      if (FORCED_RLS_MODELS.has(target) || argsReachForced(target, inner, depth + 1)) return true;
    } else if (!fields?.scalars.has(key) && argsReachForced(model, inner, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Qué tabla con FORCE RLS toca una consulta (modelo, relación o SQL crudo),
 * o null si ninguna. Para avisar de las que van fuera de una transacción.
 */
export function forcedRlsTarget(params: { model?: string; action: string; args?: unknown }): string | null {
  if (!params.model) {
    return params.action === 'queryRaw' || params.action === 'executeRaw' ? forcedTableIn(rawSqlText(params.args)) : null;
  }
  if (FORCED_RLS_MODELS.has(params.model)) return params.model;
  return argsReachForced(params.model, params.args, 0) ? `${params.model} (relación)` : null;
}
