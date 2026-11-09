// Importes en español de España: el formato de toda la app (formatMoney de
// @nightpay/contracts): coma decimal, el punto de los miles siempre
// («1.234,50 €») y el signo menos de verdad («−3,00 €»). Los importes viajan
// en céntimos enteros.

import { formatMoney } from '@nightpay/contracts';

/** 4850 → "48,50 €"; 123450 → "1.234,50 €". */
export function formatEur(cents: number): string {
  return formatMoney(cents);
}
