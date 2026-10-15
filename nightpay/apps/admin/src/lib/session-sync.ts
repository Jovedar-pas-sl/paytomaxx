// Varias pestañas comparten la sesión (localStorage). Cuando otra pestaña
// sale, entra o cambia de local, esta tiene que enterarse: si no, sigue
// enseñando el local viejo mientras sus peticiones ya van al nuevo.

export type SessionChange = 'signed-out' | 'signed-in' | 'venue-changed';

interface SessionKeys {
  token: string;
  user: string;
}

function identity(raw: string): { id?: string; tenantId?: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as { id?: string; tenantId?: string }) : null;
  } catch {
    return null;
  }
}

/**
 * Un evento `storage` → qué ha cambiado en la sesión (null = nada que hacer;
 * p. ej. otra pestaña solo renovó el token).
 */
export function classifySessionChange(
  key: string | null,
  oldValue: string | null,
  newValue: string | null,
  keys: SessionKeys,
): SessionChange | null {
  if (key === null) return 'signed-out'; // localStorage.clear()
  if (key === keys.token) {
    if (newValue === null) return 'signed-out';
    return oldValue === null ? 'signed-in' : null;
  }
  if (key !== keys.user) return null;
  if (newValue === null) return 'signed-out';
  if (oldValue === null) return 'signed-in';
  const before = identity(oldValue);
  const after = identity(newValue);
  if (!before || !after) return 'venue-changed';
  return before.id !== after.id || before.tenantId !== after.tenantId ? 'venue-changed' : null;
}
