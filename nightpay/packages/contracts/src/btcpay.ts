import { z } from 'zod';

/**
 * «Pagar con bitcoin» (BTCPay Server). Cada local conecta SU BTCPay desde
 * Ajustes → Formas de cobro. La clave de API y el secreto del aviso no salen
 * nunca del servidor: aquí solo hay lo que se puede ver o mandar.
 */

/** Para qué usa el local el bitcoin: cobros, recargas del saldo o los dos. */
export const BTCPAY_PURPOSES = ['PAYMENTS', 'TOPUPS', 'BOTH'] as const;
export type BtcpayPurpose = (typeof BTCPAY_PURPOSES)[number];

export const BTCPAY_PURPOSE_LABELS: Readonly<Record<BtcpayPurpose, string>> = {
  PAYMENTS: 'Cobros',
  TOPUPS: 'Recargas del saldo',
  BOTH: 'Cobros y recargas',
};

/** Lo que ve el dueño de la conexión (sin la clave: solo cómo termina). */
export interface BtcpaySettingsView {
  /** El interruptor del servidor (BTCPAY_ENABLED). Apagado: no hay nada de esto. */
  available: boolean;
  configured: boolean;
  enabled: boolean;
  purpose: BtcpayPurpose;
  baseUrl: string | null;
  storeId: string | null;
  /** «…a1b2» o null: para saber QUÉ clave hay sin enseñarla. */
  apiKeyHint: string | null;
  webhookRegistered: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
}

const StoreIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, 'El id de tienda son letras y números (lo ves en BTCPay, Ajustes de la tienda).');

const TotpSchema = z
  .string()
  .regex(/^\d{6}$/, 'El código 2FA son 6 cifras')
  .optional();

/** Guardar o cambiar la conexión: solo el dueño, con su 2FA. Sin `apiKey` se mantiene la que hay (solo si la dirección y la tienda no cambian). */
export const SaveBtcpaySettingsSchema = z
  .object({
    baseUrl: z.string().trim().min(1, 'Escribe la dirección de tu BTCPay').max(2048),
    storeId: StoreIdSchema,
    apiKey: z.string().trim().min(8, 'La clave de API es demasiado corta').max(300).optional(),
    enabled: z.boolean(),
    purpose: z.enum(BTCPAY_PURPOSES),
    totpCode: TotpSchema,
  })
  .strict();
export type SaveBtcpaySettingsDto = z.infer<typeof SaveBtcpaySettingsSchema>;

/** «Probar conexión»: lo guardado, o los datos que se están escribiendo (sin guardarlos). */
export const TestBtcpaySettingsSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    storeId: StoreIdSchema.optional(),
    apiKey: z.string().trim().min(8).max(300).optional(),
  })
  .strict();
export type TestBtcpaySettingsDto = z.infer<typeof TestBtcpaySettingsSchema>;

export interface BtcpayTestStep {
  id: 'health' | 'key' | 'store';
  ok: boolean;
  message: string;
}

export interface BtcpayTestResult {
  ok: boolean;
  steps: BtcpayTestStep[];
  /** Permisos que faltan y que sobran en la clave (nombres de BTCPay). */
  missingPermissions: string[];
  extraPermissions: string[];
}

/** Cambiar solo el interruptor o el uso (sin tocar la conexión). Con 2FA, como el resto. */
export const UpdateBtcpayModeSchema = z
  .object({ enabled: z.boolean(), purpose: z.enum(BTCPAY_PURPOSES), totpCode: TotpSchema })
  .strict();
export type UpdateBtcpayModeDto = z.infer<typeof UpdateBtcpayModeSchema>;

/** La factura de bitcoin de un cobro, para el personal y para la página del cliente. */
export type BtcpayInvoiceStatus = 'New' | 'Processing' | 'Settled' | 'Expired' | 'Invalid';

export interface BtcpayInvoiceView {
  invoiceId: string;
  status: BtcpayInvoiceStatus;
  amountCents: number;
  /** Importe en BTC (texto decimal) y cambio EUR por BTC, si BTCPay los dio. */
  amountBtc: string | null;
  rate: string | null;
  /** Lo que lleva el QR: bitcoin: (con &lightning= si la tienda tiene los dos) o lightning:. */
  qrLink: string;
  chainAddress: string | null;
  checkoutLink: string;
  expiresAt: string;
  /** El cobro: lo que ve quien lo cobra. */
  paymentStatus: string;
  /** El QR ya dibujado en el servidor (data:image/svg+xml;base64,…). */
  qrImage: string;
}
