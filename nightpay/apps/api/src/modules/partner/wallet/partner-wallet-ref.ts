import { LIVE_CODE_RE, walletCardTokenFromUrl, type WalletRefReason } from '@nightpay/contracts';
import { sameWalletGroup } from '../../wallets/wallet-rules';

// ─── A2. Clasificar el `qr` (solo por su forma) ─────────────────────────

/** Lo que es el `qr` por su forma. El enlace privado lleva su tramo (para el registro, nunca a ningún log). */
export type WalletRefShape =
  | { kind: 'live_code'; code: string }
  | { kind: 'ficha'; token: string }
  | { kind: 'rejected'; reason: Exclude<WalletRefReason, 'private_link'> }
  | { kind: 'rejected'; reason: 'private_link'; privateLink: string }
  | { kind: 'live_code_malformed' }
  | { kind: 'unrecognized' };

const SHORT_CODE = /^[A-Za-z0-9]{3}[- ]?[A-Za-z0-9]{3}$/;
const PRIVATE_LINK = /^[A-Za-z0-9_-]{16,64}$/;
const OTHER_LINK_ROOTS = new Set(['r', 'reservar', 'reservas']);
const UNRECOGNIZED: WalletRefShape = { kind: 'unrecognized' };

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * La forma del texto leído (el contrato, `Qr`). Pura y sin lanzar nunca. En
 * orden: el código del móvil; el QR de recepción y el código de 6; solo
 * `https:`; por el primer tramo de la ruta (cobros, pase, enlace privado,
 * otros enlaces); la ficha (cualquier host) y `?saldo=`.
 */
export function classifyWalletRef(raw: string): WalletRefShape {
  const text = raw.trim();
  if (/^oxc1:/i.test(text)) {
    const code = text.toUpperCase();
    return LIVE_CODE_RE.test(code) ? { kind: 'live_code', code } : { kind: 'live_code_malformed' };
  }
  if (text.startsWith('NPF:')) return { kind: 'rejected', reason: 'reception_qr' };
  if (SHORT_CODE.test(text)) return { kind: 'rejected', reason: 'short_code' };
  const url = parseUrl(text);
  if (!url || url.protocol !== 'https:') return UNRECOGNIZED;
  const segments = decodeSegments(url.pathname);
  if (!segments) return UNRECOGNIZED;
  const [first, second] = segments;
  if (first === 's' || first === 'pay') return { kind: 'rejected', reason: 'charge_link' };
  if (first === 'c') return { kind: 'rejected', reason: 'wallet_pass' };
  if (first === 'w') {
    return second !== undefined && PRIVATE_LINK.test(second)
      ? { kind: 'rejected', reason: 'private_link', privateLink: second }
      : { kind: 'rejected', reason: 'other_link' };
  }
  if (first !== undefined && OTHER_LINK_ROOTS.has(first)) return { kind: 'rejected', reason: 'other_link' };
  const token = walletCardTokenFromUrl(text);
  if (token) return { kind: 'ficha', token };
  if (url.searchParams.has('saldo')) return { kind: 'rejected', reason: 'short_code' };
  return UNRECOGNIZED;
}

// ─── El alcance de una clave ─────────────────────────────────────────────

/**
 * ¿Llega esta clave a este saldo? El mismo grupo que comprueba el personal
 * del local (sameWalletGroup) **y** el local de origen del saldo (donde se
 * creó) con sociedad, la misma que la del local de la clave. Pura: la usa
 * también la página del saldo (PR 8).
 */
export function walletReachable(
  wallet: { tenantId: string; walletGroup: string | null },
  home: { businessId: string | null },
  conn: { tenantId: string; walletGroup: string | null; businessId: string | null },
): boolean {
  return (
    sameWalletGroup(wallet, { id: conn.tenantId, walletGroup: conn.walletGroup }) &&
    home.businessId !== null &&
    home.businessId === conn.businessId
  );
}
