import { createHash, randomBytes } from 'node:crypto';
import { PARTNER_KEY_RE, type PartnerKeyMode } from '@nightpay/contracts';

/** Una clave nueva: se enseña una vez; se guarda solo su hash. */
export interface IssuedPartnerKey {
  key: string;
  hash: string;
  hint: string;
  mode: PartnerKeyMode;
}

/** 192 bits al azar en hex: `oxp_live_<48 hex>`. Sin firma ni JWT: se busca por su sha256. */
export function generatePartnerKey(mode: PartnerKeyMode): IssuedPartnerKey {
  const key = `oxp_${mode}_${randomBytes(24).toString('hex')}`;
  return { key, hash: hashPartnerKey(key), hint: partnerKeyHint(key), mode };
}

export function hashPartnerKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** `oxp_live_…a1b2`: el prefijo y los 4 últimos. */
export function partnerKeyHint(key: string): string {
  const mode = partnerKeyModeOf(key) ?? 'live';
  return `oxp_${mode}_…${key.slice(-4)}`;
}

/** El modo de una clave bien formada, o null. */
export function partnerKeyModeOf(key: string): PartnerKeyMode | null {
  const m = PARTNER_KEY_RE.exec(key);
  return m ? (m[1] as PartnerKeyMode) : null;
}
