import type { ReactNode } from 'react';
import type { ChargeMethod } from '@nightpay/contracts';

/** Trazos de cada icono (24×24). */
const PATHS = {
  card: 'M3 6h18v12H3zM3 10h18',
  ficha: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18ZM8.5 9.5a5 5 0 0 1 7 0M10 12a2.5 2.5 0 0 1 4 0',
  cash: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  pos: 'M7 3h10v18H7zM9.5 7h5M10 12h1M13 12h1M10 15.5h1M13 15.5h1',
  // Una moneda con la B de bitcoin.
  btc: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18ZM10 7.5v9M10 7.5h3a2 2 0 0 1 0 4h-3M10 11.5h3.5a2.5 2.5 0 0 1 0 5H10M11.5 6v1.5M11.5 16.5V18',
} as const;

type Tone = 'card' | 'saldo' | 'cash' | 'pos' | 'btc';

const BY_METHOD: Readonly<Record<ChargeMethod, { tone: Tone; path: keyof typeof PATHS }>> = {
  CARD: { tone: 'card', path: 'card' },
  MOBILE_WALLET: { tone: 'card', path: 'card' },
  SALDO: { tone: 'saldo', path: 'ficha' },
  CASH: { tone: 'cash', path: 'cash' },
  POS: { tone: 'pos', path: 'pos' },
  BITCOIN: { tone: 'btc', path: 'btc' },
};

/**
 * «Cómo pagó» con su cuadrito de icono tintado por forma de pago (tarjeta y
 * Apple/Google Pay, azul; saldo, verde agua; efectivo, verde; datáfono,
 * violeta; bitcoin, naranja). Sin forma de pago conocida, solo el texto.
 */
export function MethodMark({ method, children }: { method: ChargeMethod | null; children: ReactNode }) {
  if (!method) return <>{children}</>;
  const { tone, path } = BY_METHOD[method];
  return (
    <span className="np-how" data-tone={tone}>
      <span className="np-how-ico" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={PATHS[path]} />
        </svg>
      </span>
      <span className="np-how-text">{children}</span>
    </span>
  );
}
