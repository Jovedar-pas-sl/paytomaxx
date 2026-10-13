/** Ds_Card_Brand de Redsys → marca. Desconocida: null (no se enseña). */
const CARD_BRAND: Record<string, string> = {
  '1': 'Visa',
  '2': 'Mastercard',
  '6': 'Diners',
  '8': 'American Express',
  '9': 'JCB',
  '22': 'UnionPay',
};

export function cardBrandLabel(code: string | null | undefined): string | null {
  return code ? (CARD_BRAND[code] ?? null) : null;
}
