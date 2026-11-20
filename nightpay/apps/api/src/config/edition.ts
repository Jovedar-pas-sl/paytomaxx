import { parseEdition, type Edition } from '@nightpay/contracts';

/**
 * La edición con la que corre el API: EDITION del entorno ('club' = OxioPay,
 * por defecto; 'party' = OxioParty). Se lee de process.env, como
 * BTCPAY_ENABLED: env.ts ya la validó al arrancar (un valor que no es
 * club/party no arranca), y ConfigService.getOrThrow no ve los valores por
 * defecto. Las pruebas la cambian con vi.stubEnv('EDITION', 'party').
 */
export function currentEdition(env: Readonly<Record<string, string | undefined>> = process.env): Edition {
  return parseEdition(env.EDITION);
}

/** ¿OxioParty? Todo lo de la fiesta va detrás de esto: con 'club', nada cambia. */
export function isPartyEdition(env?: Readonly<Record<string, string | undefined>>): boolean {
  return currentEdition(env) === 'party';
}
