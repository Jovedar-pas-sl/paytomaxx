/**
 * Reglas del PIN del saldo (4 cifras que elige el cliente). Las comparten el
 * API (que es quien decide) y la app de la chica (para avisar al momento).
 */

/** Los PIN que cualquiera prueba primero no valen. */
const OBVIOUS_PINS = new Set(['1234', '4321', '0123', '3210', '1212', '2580', '1004', '2000', '1122', '6969']);

export type WalletPinProblem = 'format' | 'obvious';

/** null si vale; si no, por qué. */
export function walletPinProblem(pin: string): WalletPinProblem | null {
  if (!/^[0-9]{4}$/.test(pin)) return 'format';
  if (/^([0-9])\1{3}$/.test(pin) || OBVIOUS_PINS.has(pin)) return 'obvious';
  return null;
}

export const WALLET_PIN_PROBLEM_TEXT: Record<WalletPinProblem, string> = {
  format: 'El PIN son 4 cifras',
  obvious: 'Ese PIN es demasiado fácil de adivinar: elige otro',
};
