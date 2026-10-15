// Cuadre con el banco.

import { apiError, authedFetch } from '../http';

// ─── Cuadre con el banco ─────────────────────────────────────────────

export type BankSource = 'REDSYS' | 'PAYTEF';

export type BankItemStatus =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'NOT_PAID_HERE'
  | 'NOT_IN_OXIOPAY'
  | 'NOT_IN_BANK'
  | 'REFUND_MATCHED'
  | 'REFUND_NOT_IN_OXIOPAY'
  | 'REFUND_NOT_IN_BANK';

export interface BankStatementSummary {
  id: string;
  source: BankSource;
  fileName: string;
  periodFrom: string;
  periodTo: string;
  rowsTotal: number;
  skippedCount: number;
  otherCount: number;
  matchedCount: number;
  problemCount: number;
  bankTotalCents: number;
  oursTotalCents: number;
  superseded: boolean;
  createdAt: string;
}

export interface BankStatementItem {
  id: string;
  status: BankItemStatus;
  kind: 'SALE' | 'REFUND';
  line: number | null;
  occurredAt: string | null;
  bankAmountCents: number | null;
  oursAmountCents: number | null;
  reference: string | null;
  authCode: string | null;
  paymentId: string | null;
  venueName: string | null;
  superseded: boolean;
}

/** El cuerpo de la petición tiene un tope de 1 MB y el fichero va en base64. */
export const MAX_BANK_FILE_BYTES = 700_000;

/** Sube el fichero del portal del banco (Redsys o Paytef) y lo cuadra. */
export async function importBankStatement(input: {
  source: BankSource;
  file: File;
  periodFrom?: string;
  periodTo?: string;
}): Promise<BankStatementSummary> {
  if (input.file.size > MAX_BANK_FILE_BYTES) {
    throw new Error('El fichero es muy grande: descárgalo por semanas');
  }
  const res = await authedFetch('/v1/bank-recon/import', {
    method: 'POST',
    body: JSON.stringify({
      source: input.source,
      fileName: input.file.name,
      contentBase64: await fileToBase64(input.file),
      ...(input.periodFrom && input.periodTo ? { periodFrom: input.periodFrom, periodTo: input.periodTo } : {}),
    }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchBankStatements(): Promise<BankStatementSummary[]> {
  const res = await authedFetch('/v1/bank-recon');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function fetchBankStatement(
  id: string,
): Promise<{ statement: BankStatementSummary; items: BankStatementItem[] }> {
  const res = await authedFetch(`/v1/bank-recon/${encodeURIComponent(id)}`);
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
