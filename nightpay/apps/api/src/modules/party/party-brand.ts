/**
 * La marca que ve el asistente con OxioParty: BRAND_NAME si está (la misma
 * variable que OxioPay, common/brand.ts) y, sin ella, «OxioParty» (con
 * EDITION=party, el «OxioPay» de serie no vale).
 */
export function partyBrand(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.BRAND_NAME?.trim() || 'OxioParty';
}
