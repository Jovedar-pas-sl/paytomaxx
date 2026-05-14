/**
 * Lógica pura de resolución de comisión por categoría de cobro.
 *
 * Extraída de payments.service.ts para que sea testeable sin Prisma/Nest
 * y reutilizable desde otros sitios (reports, simulator, etc).
 */

export type RevenueCategory =
  | 'CHICA_SERVICE'
  | 'VENUE_BAR'
  | 'VENUE_ROOM'
  | 'VENUE_FOOD'
  | 'EXTRA';

export interface OperatorCommissionDefaults {
  CHICA_SERVICE: number;
  VENUE_BAR: number;
  VENUE_ROOM: number;
  VENUE_FOOD: number;
  EXTRA: number;
}

export const DEFAULT_COMMISSION_DEFAULTS: OperatorCommissionDefaults = {
  CHICA_SERVICE: 9000,
  VENUE_BAR: 0,
  VENUE_ROOM: 0,
  VENUE_FOOD: 0,
  EXTRA: 0,
};

/**
 * Resuelve la comisión efectiva (bps) para el creator OPERATOR según
 * la categoría del cobro y los overrides.
 *
 *   CHICA_SERVICE → User.commissionBps (si está) → fallback venue default
 *   VENUE_*       → siempre venue default (ingreso del local, no de chica)
 *   EXTRA         → siempre venue default
 *
 * Devuelve 0 si no hay categoría reconocida o no hay venue map.
 */
export function resolveBpsForOperator(args: {
  category: RevenueCategory | string;
  userCommissionBpsOverride: number | null;
  venueMap: OperatorCommissionDefaults | Partial<OperatorCommissionDefaults> | null;
}): number {
  const map = { ...DEFAULT_COMMISSION_DEFAULTS, ...(args.venueMap ?? {}) };

  if (args.category === 'CHICA_SERVICE' && args.userCommissionBpsOverride !== null) {
    return args.userCommissionBpsOverride;
  }
  const cat = args.category as RevenueCategory;
  if (cat in map) {
    return map[cat] ?? 0;
  }
  return 0;
}

/**
 * Infer la categoría default para un nuevo cobro cuando el DTO no la especifica.
 *
 *  - WALLET_TOPUP (hasWalletId=true) → EXTRA (la categoría real se asigna por consumption)
 *  - creator OPERATOR + sin wallet   → CHICA_SERVICE (su servicio)
 *  - cualquier otro                   → EXTRA (el camarero/admin debe elegir explícito)
 */
export function inferRevenueCategory(args: {
  hasWalletId: boolean;
  creatorRole: string | undefined | null;
}): RevenueCategory {
  if (args.hasWalletId) return 'EXTRA';
  if (args.creatorRole === 'OPERATOR') return 'CHICA_SERVICE';
  return 'EXTRA';
}
