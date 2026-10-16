import { createContext, useContext } from 'react';

/**
 * La sesión caducó con un cobro abierto: la app sigue en pantalla (el QR, su
 * cuenta atrás, su «PAGADO») pero lo que necesita la sesión no pregunta al
 * API hasta que se vuelve a entrar (los sondeos se paran y arrancan solos).
 */
export const SessionExpiredContext = createContext(false);

export function useSessionExpired(): boolean {
  return useContext(SessionExpiredContext);
}
