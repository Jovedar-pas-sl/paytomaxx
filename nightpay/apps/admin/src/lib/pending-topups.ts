// Recargas pendientes de asignar en el panel (Clientes → Saldos). Sin React:
// se prueba sola (pending-topups.test.ts).

import type { AssignedTopUp } from '@nightpay/contracts';
import { formatEur } from './money';

/** El código del saldo, como lo teclea quien mira el papel («k7q 4m2» → «K7Q-4M2»). */
export function normalizeSaldoCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 6 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

/** Por qué no se puede mandar ese código (null: vale). */
export function saldoCodeProblem(input: string): string | null {
  return /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(normalizeSaldoCode(input))
    ? null
    : 'El código del saldo son 6 letras o números (p. ej. K7Q-4M2).';
}

/** «50,00 € sumados al saldo K7Q-•••: ahora tiene 62,00 €». */
export function assignedText(a: AssignedTopUp): string {
  return `${formatEur(a.amountCents)} sumados al saldo ${a.codeHint}: ahora tiene ${formatEur(a.balanceCents)}.`;
}
