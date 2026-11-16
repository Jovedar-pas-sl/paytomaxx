import { z } from 'zod';

/**
 * «Pagar con bitcoin» (BTCPay Server). Cada local conecta SU BTCPay desde
 * Ajustes → Formas de cobro. La clave de API y el secreto del aviso no salen
 * nunca del servidor: aquí solo hay lo que se puede ver o mandar.
 */

/**
 * Dónde se ofrece el bitcoin (decisión del dueño): para cargar saldo y para
 * pagar los reservados; en la barra (los cobros), nunca. Lo mismo en todos los
 * locales: ya no se elige en Ajustes.
 */
export const BITCOIN_USE_TEXT = 'Bitcoin sirve para cargar saldo y para pagar reservados. En la barra no se ofrece.';

/**
 * El «para qué» de antes (cobros, recargas o los dos). Ya no cuenta: el API lo
 * acepta de un panel antiguo y no lo guarda. La columna sigue en la base, sin uso.
 */
export const BTCPAY_PURPOSES = ['PAYMENTS', 'TOPUPS', 'BOTH'] as const;
export type BtcpayPurpose = (typeof BTCPAY_PURPOSES)[number];

/** Lo que ve el dueño de la conexión (sin la clave: solo cómo termina). */
export interface BtcpaySettingsView {
  /** El interruptor del servidor (BTCPAY_ENABLED). Apagado: no hay nada de esto. */
  available: boolean;
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  storeId: string | null;
  /** «…a1b2» o null: para saber QUÉ clave hay sin enseñarla. */
  apiKeyHint: string | null;
  webhookRegistered: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  /** Devolver en efectivo lo pagado con bitcoin (encargado y dueño). Apagado de fábrica. */
  cashRefund: boolean;
}

const StoreIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, 'El id de tienda son letras y números (lo ves en BTCPay, Ajustes de la tienda).');

/** Las claves de BTCPay son letras y números: nada de espacios, saltos de línea ni caracteres raros que acaben en una cabecera. */
const ApiKeySchema = z
  .string()
  .trim()
  .min(8, 'La clave de API es demasiado corta')
  .max(300)
  .regex(/^[A-Za-z0-9._~+/=-]+$/, 'La clave de API solo lleva letras, números y . _ ~ + / = -');

const TotpSchema = z
  .string()
  .regex(/^\d{6}$/, 'El código 2FA son 6 cifras')
  .optional();

/** Guardar o cambiar la conexión: solo el dueño, con su 2FA. Sin `apiKey` se mantiene la que hay (solo si la dirección y la tienda no cambian). */
export const SaveBtcpaySettingsSchema = z
  .object({
    baseUrl: z.string().trim().min(1, 'Escribe la dirección de tu BTCPay').max(2048),
    storeId: StoreIdSchema,
    apiKey: ApiKeySchema.optional(),
    enabled: z.boolean(),
    /** Ya no cuenta (ver BTCPAY_PURPOSES): un panel antiguo lo manda y se ignora. */
    purpose: z.enum(BTCPAY_PURPOSES).optional(),
    totpCode: TotpSchema,
  })
  .strict();
export type SaveBtcpaySettingsDto = z.infer<typeof SaveBtcpaySettingsSchema>;

/** «Probar conexión»: lo guardado, o los datos que se están escribiendo (sin guardarlos). */
export const TestBtcpaySettingsSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2048).optional(),
    storeId: StoreIdSchema.optional(),
    apiKey: ApiKeySchema.optional(),
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

/** Cambiar solo el interruptor (sin tocar la conexión). Con 2FA, como el resto. */
export const UpdateBtcpayModeSchema = z
  .object({
    enabled: z.boolean(),
    /** Ya no cuenta (ver BTCPAY_PURPOSES): un panel antiguo lo manda y se ignora. */
    purpose: z.enum(BTCPAY_PURPOSES).optional(),
    /** Devolver en efectivo lo pagado con bitcoin. Sin el campo, no se cambia. */
    cashRefund: z.boolean().optional(),
    totpCode: TotpSchema,
  })
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
