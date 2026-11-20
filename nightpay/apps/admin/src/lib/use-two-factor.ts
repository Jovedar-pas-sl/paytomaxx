import { useEffect, useState } from 'react';
import { fetchTotpStatus } from './api';

/**
 * ¿Tiene la 2FA activada quien está dentro? Se pregunta cuando hace falta
 * (`when`). null = aún no se sabe o no se pudo preguntar: lo dirá el API al
 * guardar (TOTP_NOT_ENROLLED).
 */
export function useTwoFactorEnabled(when: boolean): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!when) return undefined;
    let cancelled = false;
    fetchTotpStatus()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [when]);
  return enabled;
}
