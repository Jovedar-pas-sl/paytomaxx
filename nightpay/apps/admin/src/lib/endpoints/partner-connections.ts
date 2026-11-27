// Ajustes → «Otras plataformas» (/v1/admin/partner-connections, la parte A).
// Con la API de socios apagada (o en OxioParty) el API contesta 404: la
// pestaña no sale. Lo que crea, cambia o reanuda una clave lleva la 2FA
// (`totpCode`) o, sin ella, la prueba de la llave de acceso en
// X-Step-Up-Token. La clave llega UNA vez en la respuesta y no se guarda
// aquí: la devuelve a quien llamó, y nada más.

import {
  STEP_UP_TOKEN_HEADER,
  type PartnerConnectionLimits,
  type PartnerConnectionView,
  type PartnerConnectionsOverview,
  type PartnerKeyIssued,
  type PartnerLoadAdminView,
  type PartnerLoadsPage,
  type PartnerOwnerStatement,
} from '@nightpay/contracts';
import { authedFetch, totpAwareError } from '../http';
import type { CreateBody, RotateBody } from '../partner-connections';

const BASE = '/v1/admin/partner-connections';

/** El segundo factor de una acción: el código de la 2FA o la prueba de la llave. */
export interface SecondFactor {
  totpCode?: string;
  stepUpToken?: string;
}

async function send<T>(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>, factor?: SecondFactor): Promise<T> {
  const res = await authedFetch(`${BASE}${path}`, {
    method,
    body: JSON.stringify({ ...body, ...(factor?.totpCode ? { totpCode: factor.totpCode } : {}) }),
    cache: 'no-store',
    ...(factor?.stepUpToken ? { headers: { [STEP_UP_TOKEN_HEADER]: factor.stepUpToken } } : {}),
  });
  if (!res.ok) throw await totpAwareError(res);
  return (await res.json()) as T;
}

function post<T>(path: string, body: Record<string, unknown>, factor?: SecondFactor): Promise<T> {
  return send('POST', path, body, factor);
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await authedFetch(`${BASE}${path}`, { signal, cache: 'no-store' });
  if (!res.ok) throw await totpAwareError(res);
  return (await res.json()) as T;
}

/** «?business_date=…&cursor=…» a mano (lo que se pide es una noche y una página, nada más). */
function query(params: Record<string, string | null | undefined>): string {
  const parts = Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Las plataformas que se pueden conectar y las conexiones del local; rechaza si la API está apagada. */
export async function fetchPartnerConnections(signal?: AbortSignal): Promise<PartnerConnectionsOverview> {
  const res = await authedFetch(BASE, { signal, cache: 'no-store' });
  if (!res.ok) throw await totpAwareError(res);
  return (await res.json()) as PartnerConnectionsOverview;
}

export function createPartnerConnection(body: CreateBody, factor: SecondFactor): Promise<PartnerKeyIssued> {
  return post('', { ...body }, factor);
}

export function rotatePartnerKey(id: string, body: RotateBody, factor: SecondFactor): Promise<PartnerKeyIssued> {
  return post(`/${encodeURIComponent(id)}/rotate`, { ...body }, factor);
}

export function resumePartnerConnection(id: string, factor: SecondFactor): Promise<PartnerConnectionView> {
  return post(`/${encodeURIComponent(id)}/resume`, {}, factor);
}

export function pausePartnerConnection(id: string): Promise<PartnerConnectionView> {
  return post(`/${encodeURIComponent(id)}/pause`, {});
}

export function revokePartnerConnection(id: string): Promise<PartnerConnectionView> {
  return post(`/${encodeURIComponent(id)}/revoke`, {});
}

// ─── «Movimientos», «Anular carga» y «Topes» (PR 3 B) ────────────────────

/** Las cargas de una noche («2026-11-26»: de las 08:00 de ese día a las 08:00 del siguiente), página a página. */
export function fetchPartnerLoads(
  id: string,
  opts: { businessDate: string; cursor?: string | null },
  signal?: AbortSignal,
): Promise<PartnerLoadsPage> {
  return get(`/${encodeURIComponent(id)}/loads${query({ business_date: opts.businessDate, cursor: opts.cursor })}`, signal);
}

/** Los totales de esa noche, con los de cada cajero. */
export function fetchPartnerStatement(id: string, businessDate: string, signal?: AbortSignal): Promise<PartnerOwnerStatement> {
  return get(`/${encodeURIComponent(id)}/statement${query({ business_date: businessDate })}`, signal);
}

/** Anular una carga (dueño y encargado, con su 2FA). Pasadas 36 h o ya gastada, 409 con el texto del servidor. */
export function voidPartnerLoad(id: string, loadId: string, reason: string, factor: SecondFactor): Promise<PartnerLoadAdminView> {
  return post(`/${encodeURIComponent(id)}/loads/${encodeURIComponent(loadId)}/void`, { reason }, factor);
}

/** Cambiar los topes (solo el dueño): la 2FA solo si sube alguno (si no, `factor` vacío). */
export function updatePartnerLimits(id: string, body: PartnerConnectionLimits, factor: SecondFactor): Promise<PartnerConnectionView> {
  return send('PATCH', `/${encodeURIComponent(id)}/limits`, { ...body }, factor);
}
