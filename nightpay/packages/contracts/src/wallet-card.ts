/**
 * Ficha NFC del saldo (NTAG213/215/216). Lleva grabado un enlace a la app de
 * cobro con un código al azar: https://operator.../?ficha=<token>. En Android
 * la app lo lee al acercarla; en iPhone el propio móvil abre el enlace.
 * La ficha solo dice de qué saldo es: para pagar, el cliente pone su PIN.
 */

/** El parámetro del enlace grabado en la ficha. */
export const WALLET_CARD_PARAM = 'ficha';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** ¿Es un código de ficha válido? */
export function isWalletCardToken(value: string): boolean {
  return TOKEN.test(value);
}

/** El código de la ficha a partir del enlace grabado (null si no es nuestra). */
export function walletCardTokenFromUrl(url: string): string | null {
  try {
    const token = new URL(url.trim()).searchParams.get(WALLET_CARD_PARAM) ?? '';
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** El enlace que se graba en la ficha. */
export function walletCardUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/?${WALLET_CARD_PARAM}=${token}`;
}

/** Número de serie de la ficha ("04:a2:3b:…") en mayúsculas y sin separadores. */
export function normalizeWalletCardUid(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length >= 8 && hex.length <= 32 ? hex : null;
}

// ─── Ciclo de vida de la ficha (20261021100000) ─────────────────────────

/**
 * STOCK (grabada, sin dar) → ISSUED (dada a un saldo) → RETURNED (devuelta:
 * otra vez en el stock) | LOST (perdida) | BLOCKED (bloqueada). Solo una
 * ficha ISSUED dice de qué saldo es; las del stock se pueden dar.
 */
export const WALLET_CARD_STATUSES = ['STOCK', 'ISSUED', 'RETURNED', 'LOST', 'BLOCKED'] as const;
export type WalletCardStatus = (typeof WALLET_CARD_STATUSES)[number];

export const WALLET_CARD_STATUS_LABEL: Readonly<Record<WalletCardStatus, string>> = {
  STOCK: 'En stock',
  ISSUED: 'Entregada',
  RETURNED: 'Devuelta',
  LOST: 'Perdida',
  BLOCKED: 'Bloqueada',
};

export function isWalletCardStatus(value: string): value is WalletCardStatus {
  return (WALLET_CARD_STATUSES as readonly string[]).includes(value);
}

/** ¿Está en el stock del local (se puede dar)? */
export function cardInStock(status: string): boolean {
  return status === 'STOCK' || status === 'RETURNED';
}

/** Lo que el panel puede hacer con una ficha. */
export type WalletCardPanelAction = 'block' | 'lost';

/** Por qué no se puede (null: se puede). Una perdida o bloqueada ya no paga. */
export function cardPanelActionProblem(status: string, action: WalletCardPanelAction): string | null {
  if (status === 'BLOCKED') return 'Esta ficha ya está bloqueada';
  if (status === 'LOST') return action === 'lost' ? 'Esta ficha ya está marcada como perdida' : 'Esta ficha está perdida: ya no paga';
  return null;
}

/** Una ficha en la lista del panel (Clientes → Fichas). */
export interface WalletCardRow {
  id: string;
  /** Número de serie (hex) si se leyó con NFC. */
  uid: string | null;
  /** Primeras letras del código grabado (para reconocerla, no para usarla). */
  tokenHint: string;
  status: WalletCardStatus;
  /** Código del saldo al que está dada (K7Q-4M2), si está entregada. */
  walletCode: string | null;
  stockedAt: string | null;
  linkedAt: string | null;
  returnedAt: string | null;
  lostAt: string | null;
  blockedAt: string | null;
  lastUsedAt: string | null;
}

/** Movimientos de fichas de una noche (o de la abierta, en vivo). */
export interface FichasNight {
  nightId: string;
  from: string;
  to: string | null;
  open: boolean;
  entregadas: number;
  devueltas: number;
  perdidas: number;
  /** En stock al cerrar (o ahora, la abierta); null en noches de antes de las fichas. */
  enStock: number | null;
}

export interface FichasSummary {
  /** Ahora, en el stock del local (STOCK + RETURNED). */
  enStock: number;
  /** Ahora, entregadas desde este local. */
  entregadas: number;
  nights: FichasNight[];
}

/**
 * Lo que dice el servidor al apuntar en el stock una ficha acercada
 * («Preparar fichas»): grabada nueva, devuelta al stock (su saldo ya está
 * gastado o cerrado) o apartada (con saldo, perdida, bloqueada o de otro local).
 */
export type StockOutcome =
  | { outcome: 'stocked' }
  | { outcome: 'returned'; codeHint: string }
  | { outcome: 'already' }
  | { outcome: 'in-use'; codeHint: string }
  | { outcome: 'blocked' }
  | { outcome: 'lost' }
  | { outcome: 'foreign' };
