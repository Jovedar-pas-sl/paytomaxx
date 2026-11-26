import { MINUS_SIGN, formatMoney } from '@nightpay/contracts';

/**
 * Los importes de los mensajes del servidor, escritos como en las apps
 * (formatMoney de @nightpay/contracts): «1.234,50 €», con el punto de los
 * miles siempre. Los importes llegan en céntimos.
 */
export interface EurOptions {
  /** «140 €» en vez de «140,00 €» cuando no hay céntimos; con céntimos, siempre los dos decimales. */
  compact?: boolean;
}

/**
 * Para lo que se lee en una pantalla (los mensajes que devuelve la API a las
 * apps): igual que `formatEur` del personal, con el espacio de no separación
 * antes de «€» y el signo menos de verdad.
 */
export function eur(cents: number, { compact = false }: EurOptions = {}): string {
  return formatMoney(cents, { compact });
}

/**
 * Para lo que sale en texto plano (Telegram, el asunto de un correo, un
 * registro): lo mismo con un espacio normal antes de «€» y el guion de
 * siempre en los negativos.
 */
export function eurPlain(cents: number, options?: EurOptions): string {
  return eur(cents, options).replace(/\u00a0/g, ' ').replace(MINUS_SIGN, '-');
}
