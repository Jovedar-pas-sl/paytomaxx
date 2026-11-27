// Ajustes → «Otras plataformas» (/v1/admin/partner-connections, la parte A).
// Con la API de socios apagada (o en OxioParty) el API contesta 404: la
// pestaña no sale. Lo que crea, cambia o reanuda una clave lleva la 2FA
// (`totpCode`) o, sin ella, la prueba de la llave de acceso en
// X-Step-Up-Token. La clave llega UNA vez en la respuesta y no se guarda
// aquí: la devuelve a quien llamó, y nada más.

import {
  STEP_UP_TOKEN_HEADER,
  type PartnerConnectionView,
  type PartnerConnectionsOverview,
  type PartnerKeyIssued,
} from '@nightpay/contracts';
import { authedFetch, totpAwareError } from '../http';
import type { CreateBody, RotateBody } from '../partner-connections';

const BASE = '/v1/admin/partner-connections';

/** El segundo factor de una acción: el código de la 2FA o la prueba de la llave. */
export interface SecondFactor {
  totpCode?: string;
  stepUpToken?: string;
}

async function post<T>(path: string, body: Record<string, unknown>, factor?: SecondFactor): Promise<T> {
  const res = await authedFetch(`${BASE}${path}`, {
    method: 'POST',
    body: JSON.stringify({ ...body, ...(factor?.totpCode ? { totpCode: factor.totpCode } : {}) }),
    cache: 'no-store',
    ...(factor?.stepUpToken ? { headers: { [STEP_UP_TOKEN_HEADER]: factor.stepUpToken } } : {}),
  });
  if (!res.ok) throw await totpAwareError(res);
  return (await res.json()) as T;
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
