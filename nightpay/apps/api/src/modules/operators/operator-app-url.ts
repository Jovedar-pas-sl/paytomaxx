import { operatorBaseUrl } from '../wallets/wallet-rules';

/**
 * Dirección de la app de las chicas, para el enlace de invitación y el de
 * onboarding: OPERATOR_BASE_URL si está; si no, la del API con "operator."
 * (como el QR de los cobros con datáfono). En local, localhost:4104.
 */
export function operatorAppBaseUrl(env: {
  operatorBaseUrl?: string;
  operatorUrl?: string;
  apiUrl?: string;
  production: boolean;
}): string | null {
  const explicit = env.operatorBaseUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return operatorBaseUrl(env.apiUrl, env.operatorUrl) ?? (env.production ? null : 'http://localhost:4104');
}
