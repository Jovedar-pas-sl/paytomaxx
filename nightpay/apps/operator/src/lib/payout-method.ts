import type { PayoutMethod } from './api';

/** Cómo se dice cada forma de cobro en una línea corta («Pagos recibidos»). */
const PAYOUT_METHOD_SHORT: Record<PayoutMethod, string> = {
  USDT_TRC20: 'USDT · Tron',
  USDT_BEP20: 'USDT · BSC',
  USDC_POLY: 'USDC · Polygon',
  USDC_SOL: 'USDC · Solana',
  BINANCE_PAY_ID: 'Binance Pay',
  OKX_INTERNAL: 'OKX',
  BYBIT_INTERNAL: 'Bybit',
  FASTERPAY_EMAIL: 'FasterPay',
  PAYQUICKER_EMAIL: 'PayQuicker',
  HYPERWALLET_TOKEN: 'Hyperwallet',
  REVOLUT_TAG: 'Revolut',
  PAYONEER_EMAIL: 'Payoneer',
  SEPA_IBAN: 'Transferencia',
  WIRE_INTERNATIONAL: 'Transferencia internacional',
  MERCADOPAGO_CVU: 'MercadoPago',
  PIX_KEY: 'Pix',
  NEQUI_PHONE: 'Nequi',
  DAVIPLATA_PHONE: 'Daviplata',
  MANUAL_CASH: 'Efectivo',
};

/** «Binance Pay», «Efectivo»…; sin método, «Pago». */
export function payoutMethodLabel(method: string | null | undefined): string {
  return (method && PAYOUT_METHOD_SHORT[method as PayoutMethod]) || 'Pago';
}
