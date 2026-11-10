import { parseCorsOrigins } from '../../common/http/cors';
import { originOf, siteOf } from '../wallets/passkey-rp';

/**
 * Dónde valen las llaves de acceso del personal: las apps del personal
 * (CORS_ORIGINS: el panel, la de las chicas y camareros, el TPV). El
 * navegador firma el origen de la página: solo se aceptan esos. El rpID es el
 * dominio común (paytomaxx.com), como el de las llaves de los clientes:
 * PASSKEY_RP_ID lo fija a mano. Una llave dada de alta en la app vale en el
 * panel (mismo dominio común). En local, las apps en localhost.
 */
export function staffRelyingParty(
  origin: string | undefined,
  env: { corsOrigins?: string; rpId?: string; production: boolean },
): { rpID: string; rpIDs: string[]; origins: string[] } {
  const listed = parseCorsOrigins(env.corsOrigins)
    .map((o) => originOf(o))
    .filter((o): o is string => o !== null);
  const dev = env.production ? [] : ['http://localhost:4103', 'http://localhost:4104', 'http://127.0.0.1:4103', 'http://127.0.0.1:4104'];
  const origins = [...new Set([...listed, ...dev])];
  const fixed = env.rpId?.trim().toLowerCase() || null;
  const rpOf = (o: string): string => fixed ?? siteOf(new URL(o).hostname);
  const asked = originOf(origin);
  const chosen = (asked && origins.includes(asked) ? asked : origins[0]) ?? 'http://localhost:4104';
  return { rpID: rpOf(chosen), rpIDs: [...new Set(origins.map(rpOf))], origins };
}

/** Las de este despliegue. */
export function currentStaffRelyingParty(origin: string | undefined): ReturnType<typeof staffRelyingParty> {
  return staffRelyingParty(origin, {
    corsOrigins: process.env.CORS_ORIGINS,
    rpId: process.env.PASSKEY_RP_ID,
    production: process.env.NODE_ENV === 'production',
  });
}
