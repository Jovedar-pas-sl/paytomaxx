'use client';

// OxioParty · «Abierta ahora» en Ajustes: quien trabaja en una caseta la abre
// o la cierra para la lista de casetas que ven los asistentes en la página de
// su pulsera (GET y PATCH /v1/party/my-stall). Sin caseta (o con OxioPay, que
// da 404) no sale nada.

import type { MyStall } from '@nightpay/contracts';
import { operatorApiError } from './api';

export const MY_STALL_PATH = '/v1/party/my-stall';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

function isMyStall(body: unknown): body is MyStall {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<Record<keyof MyStall, unknown>>;
  return typeof b.id === 'string' && typeof b.name === 'string' && typeof b.openNow === 'boolean';
}

function stallOf(body: unknown): MyStall | null {
  const stall = body && typeof body === 'object' ? (body as { stall?: unknown }).stall : null;
  return isMyStall(stall) ? stall : null;
}

/** La caseta de quien entra; null sin caseta o si no se puede saber (entonces no se enseña). */
export async function loadMyStall(fetcher: Fetcher, signal?: AbortSignal): Promise<MyStall | null> {
  try {
    const res = await fetcher(MY_STALL_PATH, signal ? { signal } : {});
    if (!res.ok) return null;
    return stallOf(await res.json());
  } catch {
    return null;
  }
}

/** Abrirla o cerrarla (se manda cómo queda, no «cambiar»: dos toques seguidos no la dejan al revés). */
export async function saveMyStallOpen(fetcher: Fetcher, openNow: boolean): Promise<MyStall> {
  const res = await fetcher(MY_STALL_PATH, { method: 'PATCH', body: JSON.stringify({ openNow }) });
  if (!res.ok) throw await operatorApiError(res, 'Caseta');
  const stall = stallOf(await res.json().catch(() => null));
  if (!stall) throw new Error('No se pudo guardar. Inténtalo otra vez.');
  return stall;
}
