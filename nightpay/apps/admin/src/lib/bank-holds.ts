// Ventas por datáfono sin cuadrar con el banco (H-1): sus textos en la ficha
// de la chica y en el pago. Sin React: se prueba en bank-holds.test.ts.

import { BANK_RELEASE_CODES, type BankHoldSale, type BankReleaseBlock } from '@nightpay/contracts';
import { formatEur } from './money';

/** «1 venta por datáfono» / «3 ventas por datáfono». */
export function salesCount(count: number): string {
  return count === 1 ? '1 venta por datáfono' : `${count} ventas por datáfono`;
}

/** «Pendiente de cuadrar con el banco: 180 € (1 venta por datáfono)»; null si no hay nada retenido. */
export function bankHoldLine(balance: { bankHeldCents?: number; bankHeldCount?: number }): string | null {
  const cents = Math.max(0, balance.bankHeldCents ?? 0);
  if (cents <= 0) return null;
  const count = Math.max(1, balance.bankHeldCount ?? 1);
  return `Pendiente de cuadrar con el banco: ${formatEur(cents)} (${salesCount(count)})`;
}

/** Para la confirmación del pago: lo retenido no entra en él. */
export function payoutHoldNote(balance: { bankHeldCents?: number; bankHeldCount?: number }): string | null {
  const cents = Math.max(0, balance.bankHeldCents ?? 0);
  if (cents <= 0) return null;
  return `No entra en este pago: ${formatEur(cents)} de ${salesCount(Math.max(1, balance.bankHeldCount ?? 1))} pendientes de cuadrar con el banco. Se pagan al cuadrar el fichero del banco o si el dueño las libera.`;
}

/** Cómo se dio por cobrada, dicho corto. */
export function saleVia(sale: Pick<BankHoldSale, 'via' | 'confirmedBy' | 'receiptRef'>): string {
  const who =
    sale.via === 'datafono'
      ? `datáfono${sale.confirmedBy ? ` ${sale.confirmedBy}` : ''} sin comprobar con Paytef`
      : `confirmada por ${sale.confirmedBy ?? 'un camarero'}`;
  const ref = sale.receiptRef ? ` · ${sale.via === 'datafono' ? 'operación' : 'ticket'} ${sale.receiptRef}` : '';
  return `${who}${ref}`;
}

/** Por qué quien mira no la puede liberar (null: sí puede). */
export function releaseBlockText(block: BankReleaseBlock): string | null {
  if (block === 'not_owner') return 'Solo el dueño la puede liberar (con su 2FA).';
  if (block === 'own_sale') return 'La apuntaste o la confirmaste tú: la libera otro dueño, o el cuadre con el banco.';
  return null;
}

/** El error de «Liberar», en una frase. */
export function releaseErrorText(err: { code?: string | null; message?: string } | null): string {
  switch (err?.code) {
    case BANK_RELEASE_CODES.OWN_SALE:
      return 'Esta venta la apuntaste o la confirmaste tú: la tiene que liberar otro dueño, o cuadrarla con el fichero del banco.';
    case BANK_RELEASE_CODES.OWNER_ONLY:
      return 'Solo el dueño puede liberar una venta por datáfono.';
    case BANK_RELEASE_CODES.NOT_HELD:
      return 'Esta venta ya no está retenida: su comisión se paga como las demás.';
    default:
      return err?.message || 'No se ha podido liberar. Vuelve a probar.';
  }
}

/** Lo que se confirma antes de liberar. */
export function releaseConfirmText(sale: Pick<BankHoldSale, 'ref' | 'chargedCents' | 'shareCents'>, name: string): string {
  const what = sale.ref ? `la venta ${sale.ref}` : 'esta venta';
  return `Doy por cobrada ${what} de ${formatEur(sale.chargedCents)} sin el cuadre del banco: ${formatEur(sale.shareCents)} de ${name} entran en su próximo pago.`;
}
