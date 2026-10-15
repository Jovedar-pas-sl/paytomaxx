// Datáfonos y su app vinculada.

import { apiError, authedFetch } from '../http';

// ─── Terminals (Track A — red PAX por zona) ───────────────────────

export interface Terminal {
  id: string;
  externalId: string;
  label: string;
  zone: string | null;
  zoneDisplay: string | null;
  hardwareModel: string | null;
  deviceSerial: string | null;
  active: boolean;
  /** App NightPay del datáfono vinculada. */
  devicePaired?: boolean;
  deviceLastSeenAt?: string | null;
}

/** Código para vincular la app NightPay de un datáfono (vale 15 minutos). */
export async function createPairingCode(terminalId: string): Promise<{ code: string; expiresAt: string }> {
  const res = await authedFetch(`/v1/pos-device/terminals/${terminalId}/pairing-code`, { method: 'POST', body: '{}' });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function unpairTerminal(terminalId: string): Promise<void> {
  const res = await authedFetch(`/v1/pos-device/terminals/${terminalId}/device`, { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
}

export async function fetchTerminals(): Promise<Terminal[]> {
  const res = await authedFetch('/v1/terminals');
  if (!res.ok) throw new Error('Error cargando terminales');
  return res.json();
}

export async function createTerminal(input: {
  externalId: string;
  label: string;
  zone?: 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO';
  zoneCustom?: string;
  hardwareModel?: string;
  deviceSerial?: string;
  active?: boolean;
}): Promise<Terminal> {
  const res = await authedFetch('/v1/terminals', {
    method: 'POST',
    body: JSON.stringify({ active: true, ...input }),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function bulkCreateTerminals(input: {
  count: number;
  prefix: string;
  zone: 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO';
  zoneCustom?: string;
  hardwareModel?: string;
}): Promise<Terminal[]> {
  const res = await authedFetch('/v1/terminals/bulk', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

export async function updateTerminal(
  id: string,
  input: {
    label?: string;
    zone?: 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO' | null;
    zoneCustom?: string | null;
    hardwareModel?: string | null;
    deviceSerial?: string | null;
    active?: boolean;
  },
): Promise<Terminal> {
  const res = await authedFetch(`/v1/terminals/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
