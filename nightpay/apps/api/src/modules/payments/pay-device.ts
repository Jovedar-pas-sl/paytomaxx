import { IN_APP_BROWSERS } from '../../common/http/client-device';

/**
 * Qué puede usar el cliente para pagar, según su navegador (User-Agent).
 *
 * Dentro de Instagram, Facebook o TikTok el enlace se abre en su navegador
 * interno, donde Apple Pay y Google Pay no funcionan: se avisa y se ofrece
 * la tarjeta.
 */
export interface PayDevice {
  wallet: 'Apple Pay' | 'Google Pay' | null;
  /** Nombre de la app cuyo navegador interno se está usando. */
  inApp: string | null;
}

export function detectPayDevice(userAgent: string | undefined): PayDevice {
  const ua = userAgent ?? '';
  const inApp = IN_APP_BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  if (inApp) return { wallet: null, inApp };
  if (/iPhone|iPad|iPod/i.test(ua)) return { wallet: 'Apple Pay', inApp: null };
  if (/Android/i.test(ua)) return { wallet: 'Google Pay', inApp: null };
  // Safari de Mac (y iPad en modo escritorio, que se anuncia como Mac).
  if (/Macintosh/i.test(ua) && /Safari/i.test(ua) && !/Chrome|Chromium|Firefox|Edg|OPR/i.test(ua)) {
    return { wallet: 'Apple Pay', inApp: null };
  }
  return { wallet: null, inApp: null };
}
