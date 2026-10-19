// «Por aprobar»: el encargado pide pagos a las chicas y devoluciones grandes;
// el dueño las aprueba (con su 2FA) o las rechaza (con el motivo).

import type {
  ApprovalListResponse,
  ApprovalRules,
  ApprovalStatus,
  ApprovalView,
} from '@nightpay/contracts';
import { apiError, authedFetch, totpAwareError } from '../http';

export type { ApprovalRequestedResponse, ApprovalRules, ApprovalStatus, ApprovalView } from '@nightpay/contracts';

/** El dueño ve todas las del local; el encargado, las suyas. Sin estado: las últimas de todos. */
export async function fetchApprovals(status?: ApprovalStatus, limit = 50): Promise<ApprovalView[]> {
  const query = new URLSearchParams({ limit: String(limit), ...(status ? { status } : {}) });
  const res = await authedFetch(`/v1/approvals?${query.toString()}`);
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as ApprovalListResponse).items;
}

/** Qué le toca a quien mira: pedir o hacerlo directo, y desde cuánto se piden las devoluciones. */
export async function fetchApprovalRules(): Promise<ApprovalRules> {
  const res = await authedFetch('/v1/approvals/rules');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function approveApproval(id: string, totpCode: string): Promise<ApprovalView> {
  const res = await authedFetch(`/v1/approvals/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ totpCode }),
  });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}

export async function rejectApproval(id: string, note: string): Promise<ApprovalView> {
  const res = await authedFetch(`/v1/approvals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
