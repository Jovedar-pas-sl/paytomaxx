import { z } from 'zod';
import { fichaNumberText } from './reception';
import type { WalletCardStatus } from './wallet-card';

// ═══════════════════════════════════════════════════════════════════════
// OxioParty: las pulseras (las fichas NFC del saldo, wallet_cards) en el
// panel del organizador. Solo con EDITION=party (con club, 404).
//
//   GET  /v1/admin/party/pulseras?q=&status=   recuento por estado y la lista (buscador por número)
//   POST /v1/admin/party/pulseras/lote         preparar N pulseras de una vez (al stock)
//   GET  /v1/admin/party/pulseras/hoja?desde=&hasta=   hoja para imprimir: número y QR de cada una
//   POST /v1/admin/party/pulseras/:id/sustituir   perdida: se bloquea y su saldo pasa a otra del stock
//
// El número de una pulsera es el de la ficha (wallet_cards.number, uno para
// siempre), escrito «P-0412».
// ═══════════════════════════════════════════════════════════════════════

/** «P-0412»: el número de la pulsera tal como va impreso. */
export function pulseraLabel(number: number): string {
  return `P-${fichaNumberText(number)}`;
}

/** «P-0412», «p0412», «0412» o «412» → 412; otra cosa → null. */
export function parsePulseraNumber(raw: string | null | undefined): number | null {
  const m = /^\s*(?:[Pp]\s*-?\s*)?0*(\d{1,9})\s*$/.exec(raw ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Cuántas se preparan (y se imprimen) como mucho de una vez. */
export const PULSERA_BATCH_MAX = 500;

export const PreparePulserasSchema = z
  .object({
    count: z
      .number()
      .int('Pon un número entero de pulseras')
      .min(1, 'Al menos una pulsera')
      .max(PULSERA_BATCH_MAX, `Como mucho ${PULSERA_BATCH_MAX} de una vez`),
  })
  .strict();
export type PreparePulserasDto = z.infer<typeof PreparePulserasSchema>;

/** La pulsera nueva (del stock) que sustituye a la perdida: su número («P-0413» o «413»). */
export const ReplacePulseraSchema = z
  .object({
    nueva: z
      .string()
      .trim()
      .max(20)
      .refine((v) => parsePulseraNumber(v) !== null, 'Escribe el número de la pulsera nueva (P-0413)'),
  })
  .strict();
export type ReplacePulseraDto = z.infer<typeof ReplacePulseraSchema>;

/** Una pulsera en el panel. Nunca el código grabado (es lo que paga). */
export interface PulseraRow {
  id: string;
  number: number;
  /** «P-0412». */
  label: string;
  status: WalletCardStatus;
  /** El código del saldo al que está dada (K7Q-4M2), si está entregada o perdida con su saldo. */
  walletCode: string | null;
  /** Lo que tiene su saldo ahora (solo con saldo). */
  balanceCents: number | null;
  /** Ya se leyó con NFC (tiene número de serie: una copia no vale). */
  hasUid: boolean;
  stockedAt: string | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
  blockedAt: string | null;
  lostAt: string | null;
}

export type PulseraCounts = Record<WalletCardStatus, number> & { total: number };

export interface PulserasView {
  counts: PulseraCounts;
  /** Como mucho 100, la más reciente primero (o las que encuentra el buscador). */
  rows: PulseraRow[];
}

/** Lo que devuelve «Preparar»: cuántas y de qué número a qué número (para imprimirlas). */
export interface PreparedPulseras {
  count: number;
  first: number;
  last: number;
  firstLabel: string;
  lastLabel: string;
}

/** La perdida (ya bloqueada) y la nueva, dada al mismo saldo. */
export interface ReplacedPulsera {
  from: PulseraRow;
  to: PulseraRow;
  balanceCents: number;
}

// ─── El estado del cobro del saldo (app del personal) ──────────────────

/**
 * GET /v1/wallet-charges/:id ya pagado, con OxioParty: además de lo de
 * siempre (newBalanceCents…), la pulsera y lo que le queda, para el PAGADO
 * aunque se pagara con el QR. Sin pulsera, `pulsera` no va. Con OxioPay no va nada.
 */
export interface SaldoChargePartyExtras {
  /** «P-0412»: la pulsera con la que se pagó o, pagado con el QR, la que tiene dada el saldo. */
  pulsera?: string;
  /** Lo que le queda en el saldo (el mismo valor que newBalanceCents). */
  balanceLeftCents?: number;
}
