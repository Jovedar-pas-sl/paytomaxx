'use client';

import { createContext, useContext } from 'react';

/** Abrir la ficha de un saldo o de una chica desde cualquier lista del panel. */
export interface FichasApi {
  openWallet: (walletId: string) => void;
  /** onChanged: lo que se haga en la ficha (un pago, un dato) avisa a quien la abrió. */
  openOperator: (operatorId: string, onChanged?: () => void) => void;
}

export const FichasContext = createContext<FichasApi | null>(null);

/** null fuera del panel (pruebas, otra pantalla): los enlaces se pintan como texto. */
export function useFichas(): FichasApi | null {
  return useContext(FichasContext);
}
