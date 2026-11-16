import { z } from 'zod';
import { ChargeLinesSchema } from './charge-lines';
import { UuidSchema } from './common';

export const PaymentStatusSchema = z.enum([
  'CREATED',
  'AWAITING_CAPTURE',
  'AUTHORIZING',
  'AUTHORIZED',
  'FAILED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'ORPHAN',
  'CANCELED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const ProviderSchema = z.enum(['WIPAY', 'PEANPE', 'PAYTEF', 'REDSYS', 'BTCPAY']);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Zonas físicas del venue para routing del PAX (Track A POS_EXTERNAL).
 *  - BARRA: barra del bar
 *  - HABITACIONES: habitaciones del hospedaje
 *  - MESAS: mesas del salón
 *  - OTRO: zona personalizada (requiere `zoneCustom` con el nombre real)
 *
 * Backward compat: payments antiguos pueden no tener zone (terminalExternalId
 * directo). Si Terminal.zone existe, predomina routing por zona.
 */
export const TerminalZoneSchema = z.enum(['BARRA', 'HABITACIONES', 'MESAS', 'OTRO']);
export type TerminalZone = z.infer<typeof TerminalZoneSchema>;

// ─── Crear pago (TPV → API) ──────────────────────────────────────────

/**
 * Modo de captura del cobro:
 * - QR: cliente escanea QR con su móvil, paga via PSP de NightPay (default).
 * - WALLET_TOPUP: top-up de un ClientWallet (Phase 1B).
 * - POS_EXTERNAL: la chica crea el cobro pero el cliente paga en el datáfono
 *   del bar (Redsys/SumUp/etc., NO el PSP de NightPay). El camarero confirma
 *   manualmente tras procesar la tarjeta en el datáfono. NightPay solo
 *   tracking + comisión chica.
 */
export const CaptureMethodSchema = z.enum(['QR', 'WALLET_TOPUP', 'POS_EXTERNAL']);
export type CaptureMethod = z.infer<typeof CaptureMethodSchema>;

/**
 * Destino de la propina. 'operator' = chica que creó el cobro; 'venue' = local;
 * 'shared' = pool (futuro); 'beneficiary' = userId explícito (campo tipBeneficiaryUserId).
 */
export const TipGoesToSchema = z.enum(['operator', 'venue', 'shared', 'beneficiary']);
export type TipGoesTo = z.infer<typeof TipGoesToSchema>;

/**
 * Categoría contable del cobro. Determina (a) si va a earnings de la chica
 * creator y a qué bps, y (b) cómo se agrega en el Z-report.
 *
 *  CHICA_SERVICE → servicio profesional de la chica (tiempo, compañía).
 *                  Usa User.commissionBps (override) o Venue.operatorCommissionDefaults.CHICA_SERVICE.
 *                  Default venue: 9000 bps = 90% para la chica.
 *  VENUE_BAR     → bebidas vendidas por el local. Default venue: 0% (es ingreso local).
 *  VENUE_ROOM    → alquiler de habitación. Default venue: 0%.
 *  VENUE_FOOD    → comida vendida por el local. Default venue: 0%.
 *  VENUE_ENTRY   → entradas del local. Default venue: 0%.
 *  EXTRA         → «Otros»: solo cobros antiguos (los nuevos siempre llevan
 *                  sección; ver sections.ts). Default venue: 0%.
 *
 * Cada venue puede ajustar los % en cada categoría desde admin → Settings.
 */
export const RevenueCategorySchema = z.enum([
  'CHICA_SERVICE',
  'VENUE_BAR',
  'VENUE_ROOM',
  'VENUE_FOOD',
  'VENUE_ENTRY',
  'EXTRA',
]);
export type RevenueCategory = z.infer<typeof RevenueCategorySchema>;

/**
 * Mapa de comisiones por categoría en bps. Almacenado en Venue.operatorCommissionDefaults.
 * Todas las categorías son required en el shape para evitar ambigüedad de defaults.
 */
export const OperatorCommissionDefaultsSchema = z.object({
  CHICA_SERVICE: z.number().int().min(0).max(10000),
  VENUE_BAR: z.number().int().min(0).max(10000),
  VENUE_ROOM: z.number().int().min(0).max(10000),
  VENUE_FOOD: z.number().int().min(0).max(10000),
  /** Entradas (sección nueva, 20261023100000): sin ella, 0. */
  VENUE_ENTRY: z.number().int().min(0).max(10000).optional(),
  EXTRA: z.number().int().min(0).max(10000),
});
export type OperatorCommissionDefaults = z.infer<typeof OperatorCommissionDefaultsSchema>;

export const CreatePaymentSchema = z.object({
  /**
   * Importe. Con `lines` no hace falta: el total lo calcula el servidor (si
   * viene, se ignora). Sin `lines`, obligatorio (con un servicio de la carta,
   * el servidor usa el precio de la carta).
   */
  amountCents: z.number().int().positive().max(10_000_00, 'Max 10.000,00 EUR').optional(),
  /**
   * externalId del terminal específico (ej. "BARRA-1"). Opcional cuando se
   * pasa `zone` — el backend resuelve un terminal de esa zona automáticamente.
   * Si se pasan los dos, terminalExternalId tiene preferencia.
   */
  terminalExternalId: z.string().min(1).max(80).optional(),
  /**
   * Track A — Routing por zona física (cuando el venue tiene 6-8 PAX por zona).
   * Si zone=OTRO, también requiere `zoneCustom` con el nombre real.
   * Si solo se pasa `zone`, el backend resuelve un terminal activo de esa zona.
   */
  zone: TerminalZoneSchema.optional(),
  zoneCustom: z.string().min(1).max(40).optional(),
  currency: z.string().length(3).default('EUR'),
  /**
   * Phase 1B opcional — si presente, este pago es un top-up de ClientWallet.
   * - create: true → crea una wallet nueva, walletId queda en la response.
   * - walletId: <uuid> → suma al balance de una wallet existente al AUTHORIZED.
   * (Mutex con captureMethod=POS_EXTERNAL: no se puede top-upear via POS.)
   */
  wallet: z
    .union([
      z.object({
        create: z.literal(true),
        identifier: z.string().min(1).max(200).optional(),
      }),
      z.object({
        walletId: UuidSchema,
      }),
    ])
    .optional(),
  /**
   * POS_EXTERNAL: la chica crea el cobro, el camarero procesa la tarjeta en
   * el datáfono del bar, después confirma en NightPay. No hay PSP roundtrip.
   */
  captureMethod: CaptureMethodSchema.optional(),
  /**
   * Propina opcional. Solo se apunta si la pasarela del local la cobra y la
   * confirma (Redsys, cobro con QR): el cliente la ve como opción en la página
   * de pago y al pagarse cuenta la que cobró el banco. Por datáfono cuenta la
   * que diga el datáfono; con otras pasarelas y en recargas de saldo se ignora
   * (queda a 0). El servidor rechaza más que el importe o más de 500 €, y el
   * tope del local para la chica cuenta importe + propina.
   *  - se asigna según tipGoesTo (default 'operator' si el creator es OPERATOR).
   *    La chica (OPERATOR) solo puede elegir 'operator' o 'venue'.
   *  - tipBeneficiaryUserId override cuando tipGoesTo='beneficiary'.
   */
  tipCents: z.number().int().nonnegative().max(5_000_00, 'Tip máx 5.000,00 EUR').optional(),
  tipGoesTo: TipGoesToSchema.optional(),
  tipBeneficiaryUserId: UuidSchema.optional(),
  /**
   * Sección del cobro (petición antigua de una sola línea). Si se omite (o
   * llega EXTRA), el servidor la saca, en orden, de la carta, del puesto de
   * quien cobra y de su rol (chica → Servicios, resto → Copas). Nunca EXTRA.
   */
  revenueCategory: RevenueCategorySchema.optional(),
  /**
   * Fase 1A — servicio de la carta del local. Si viene, el servidor usa SU
   * precio y SU categoría (amountCents y revenueCategory del cliente se ignoran).
   */
  serviceItemId: UuidSchema.optional(),
  /**
   * El mapa del dinero: varias líneas, cada una a su sección (de la carta o
   * importe tecleado en una sección). El total lo calcula el servidor. No en
   * una recarga de saldo (no es una venta).
   */
  lines: ChargeLinesSchema.optional(),
  /**
   * «Copa con invitación»: el QR personal de la chica invitada (la URL entera
   * o su token). Hace falta si se cobra una invitación de la carta.
   */
  invitedStaffToken: z.string().trim().min(20).max(600).optional(),
  /**
   * «Copa con invitación» eligiendo a la chica de la lista (sin su QR): solo si
   * el local no pide su QR (Ajustes → Invitaciones). Uno u otro, no los dos.
   */
  invitedOperatorId: UuidSchema.optional(),
  /**
   * Cobro único: el mismo cobro se puede pagar también con el saldo del
   * cliente (su NFC en el móvil de quien cobra, su PIN o su Face ID desde la
   * página de pago). Lleva enlazado un cobro del saldo con el mismo importe,
   * la misma referencia y las mismas líneas. Gana el primero que se paga: el
   * otro se cancela. Se ignora si el local no cobra con saldo. Las apps
   * antiguas no lo mandan: solo tarjeta, como siempre.
   */
  withSaldo: z.boolean().optional(),
}).refine(
  (d) => d.terminalExternalId !== undefined || d.zone !== undefined,
  { message: 'Debes pasar terminalExternalId o zone' },
).refine(
  (d) => d.zone !== 'OTRO' || (d.zoneCustom !== undefined && d.zoneCustom.length > 0),
  { message: 'zoneCustom obligatorio cuando zone=OTRO' },
).refine(
  (d) => d.amountCents !== undefined || d.lines !== undefined,
  { message: 'Pon el importe o lo que se cobra', path: ['amountCents'] },
).refine(
  (d) => !(d.wallet && d.lines),
  { message: 'Una recarga de saldo no lleva líneas: no es una venta', path: ['lines'] },
).refine(
  (d) => !(d.withSaldo && (d.wallet || d.captureMethod === 'POS_EXTERNAL')),
  { message: 'Una recarga o un cobro con datáfono no se pagan con el saldo', path: ['withSaldo'] },
).refine(
  (d) => !(d.invitedStaffToken && d.invitedOperatorId),
  { message: 'O el QR de la chica o la chica de la lista, no los dos', path: ['invitedOperatorId'] },
);
export type CreatePaymentDto = z.infer<typeof CreatePaymentSchema>;

/**
 * 409 cuando se intenta pagar con el saldo un cobro que ya se pagó con la
 * tarjeta (o al revés): «Ya está pagado». Nunca se cobra dos veces.
 */
export const ALREADY_PAID_CODE = 'ALREADY_PAID';
export const ALREADY_PAID_MESSAGE = 'Ya está pagado';

/**
 * Confirmación POS — camarero/manager marca cobrado tras procesar la tarjeta
 * en el datáfono externo.
 *
 * `posReceiptRef` es el CÓDIGO DE AUTORIZACIÓN del ticket del datáfono
 * (6 letras o números, "AUT" / "Nº autorización"). Antes valía cualquier
 * texto de 3 caracteres; ahora se valida el formato y el servidor rechaza
 * un código ya usado en el mismo terminal (Fase 0).
 *
 * `posReceiptPhoto`: data URL del ticket fotografiado por el camarero. Opcional
 * pero recomendado en disputes. Tamaño máx 500KB para evitar payloads enormes.
 */
export const ConfirmPosPaymentSchema = z.object({
  posReceiptRef: z
    .string()
    .transform((s) => s.replace(/\s+/g, '').toUpperCase())
    .pipe(
      z
        .string()
        .regex(/^[A-Z0-9]{6}$/, 'Teclea el código de autorización del ticket: 6 letras o números'),
    ),
  posReceiptPhoto: z
    .string()
    .startsWith('data:image/')
    .max(500_000, 'Foto máx 500KB — comprime antes de subir')
    .optional(),
  notes: z.string().max(500).optional(),
  /**
   * Lo que se cobró en el datáfono (sin propina): el importe + la «Comisión
   * del servicio». Si el cobro la lleva, es obligatorio (una app de antes,
   * que enseña el importe sin ella, recibe 409 SERVICE_FEE_APP_OUTDATED) y
   * tiene que ser el total (si no, 409 POS_CHARGE_MISMATCH). Sin comisión,
   * opcional (si va, el importe).
   */
  chargedCents: z.number().int().positive().max(100_000_00).optional(),
});
export type ConfirmPosPaymentDto = z.infer<typeof ConfirmPosPaymentSchema>;

// ─── Respuesta de creación (TPV recibe esto) ─────────────────────────
export const CreatedPaymentResponseSchema = z.object({
  id: UuidSchema,
  /** El consumo o, en una recarga, el saldo (sin la comisión del servicio ni la propina). */
  amountCents: z.number().int(),
  /**
   * «Comisión del servicio» de este cobro (service-fee.ts): la paga el cliente
   * encima de amountCents si paga con tarjeta o datáfono (con el saldo, no). 0
   * sin ella. Opcional: el API anterior no la manda.
   */
  serviceFeeCents: z.number().int().nonnegative().optional(),
  /** Su % (bps); null = sin comisión (interruptor apagado). */
  serviceFeeBps: z.number().int().nullable().optional(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  qrToken: z.string(),
  qrUrl: z.string().url().describe('URL completa que va dentro del QR'),
  qrPngDataUrl: z
    .string()
    .startsWith('data:image/png;base64,')
    .describe('PNG del QR ya renderizado, embebido como data URL'),
  qrExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  /** Referencia corta del cobro en el local (C-0001). Null en los antiguos. */
  ref: z.string().nullable().optional(),
  /** Las líneas del cobro, cada una en su sección (vacío en una recarga). */
  lines: z
    .array(
      z.object({
        category: z.string(),
        label: z.string(),
        qty: z.number().int(),
        unitCents: z.number().int(),
        amountCents: z.number().int(),
        serviceItemId: z.string().nullable(),
      }),
    )
    .optional(),
  /**
   * Solo cuando el pago es una recarga de saldo. El enlace del saldo (la
   * credencial del cliente) no se devuelve nunca al personal: el cliente lo
   * recibe en su página de "Pagado".
   */
  walletId: UuidSchema.nullable().optional(),
  /**
   * Cobro único (`withSaldo`): el cobro del saldo enlazado, para pagarlo con
   * el NFC o el PIN en el móvil de quien cobra (POST /v1/wallet-charges/:id/nfc
   * o /pin) y para saber si ya lo pagó. Null: solo tarjeta.
   */
  saldo: z
    .object({
      chargeId: UuidSchema,
      expiresAt: z.string().datetime(),
    })
    .nullable()
    .optional(),
});
export type CreatedPaymentResponse = z.infer<typeof CreatedPaymentResponseSchema>;

// ─── Lookup público por QR token (cliente escanea) ───────────────────
export const PublicPaymentViewSchema = z.object({
  /**
   * Solo ya pagado (AUTHORIZED, PARTIALLY_REFUNDED, REFUNDED): el código de
   * confirmación del «Pagado» sale del id, y antes de pagar no se da.
   */
  id: UuidSchema.optional(),
  amountCents: z.number().int(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  venueName: z.string(),
  terminalLabel: z.string(),
  qrExpiresAt: z.string().datetime(),
  /** Referencia corta (C-0001): la que ven la chica en el PAGADO y el cliente en sus movimientos. */
  ref: z.string().nullable().optional(),
  /**
   * Propina que dejó el cliente: solo cuando ya está pagado (antes puede
   * cambiar). La usa el sondeo del personal sin tiempo real; opcional, las
   * apps viejas no la leen.
   */
  tipCents: z.number().int().nonnegative().optional(),
  /** «Comisión del servicio» del cobro (encima de amountCents; 0 sin ella). Opcional: API anterior. */
  serviceFeeCents: z.number().int().nonnegative().optional(),
  /**
   * Esperando al banco (AUTHORIZING) o sin su respuesta (ORPHAN): cuándo salió
   * el intento hacia el banco (la espera se cuenta desde ahí, pay-wait.ts).
   * En los demás estados no va. Opcional: API anterior.
   */
  attemptStartedAt: z.string().datetime().nullable().optional(),
  /**
   * Solo ya pagado: cómo pagó el cliente. «wallet» = Apple Pay o Google Pay (el
   * banco no dice cuál de los dos); «card» = tarjeta; «bitcoin» = con su factura
   * de BTCPay (el dinero está en la cartera del local, no en el banco). Opcional:
   * las apps de antes no conocen «bitcoin» y lo ignoran.
   */
  payMethod: z.enum(['card', 'wallet', 'bitcoin']).optional(),
  /**
   * El cliente paga con bitcoin (una factura de BTCPay). Opcional (API anterior).
   * Lo usa la pantalla del personal:
   *  - 'open' (AUTHORIZING): la factura espera el pago → se puede cancelar el cobro (la cierra);
   *  - 'confirming' (AUTHORIZING): el pago ya está en la red, falta su confirmación → no se cancela;
   *  - 'problem' (AUTHORIZING): la factura se cerró con un pago a medias, tardío o que no cuadra (Incidencias);
   *  - 'closed' (AWAITING_CAPTURE): la factura se cerró sin pagarse (caducó o el cliente eligió
   *    pagar de otra forma) y el cobro vuelve a estar abierto.
   */
  bitcoin: z.enum(['open', 'confirming', 'problem', 'closed']).optional(),
});
export type PublicPaymentView = z.infer<typeof PublicPaymentViewSchema>;
/** Cómo va el pago con bitcoin de un cobro (PublicPaymentView.bitcoin). */
export type BitcoinPayState = NonNullable<PublicPaymentView['bitcoin']>;

// ─── Detalle interno (admin ve esto) ─────────────────────────────────
export const PaymentDetailSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  terminalId: UuidSchema,
  amountCents: z.number().int(),
  availableAmountCents: z.number().int(),
  currency: z.string().length(3),
  status: PaymentStatusSchema,
  provider: ProviderSchema.nullable(),
  providerTxId: z.string().nullable(),
  createdByUserId: UuidSchema.nullable(),
  createdByName: z.string().nullable(),
  qrExpiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PaymentDetail = z.infer<typeof PaymentDetailSchema>;

// ─── Refund ──────────────────────────────────────────────────────────
export const RefundRequestSchema = z.object({
  paymentId: UuidSchema,
  amountCents: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type RefundRequestDto = z.infer<typeof RefundRequestSchema>;

// ─── WS events (server → client) ─────────────────────────────────────
export const PaymentUpdateEventSchema = z.object({
  type: z.literal('payment:update'),
  paymentId: UuidSchema,
  status: PaymentStatusSchema,
  amountCents: z.number().int(),
  timestamp: z.string().datetime(),
});
export type PaymentUpdateEvent = z.infer<typeof PaymentUpdateEventSchema>;

export const PaymentCompletedEventSchema = z.object({
  type: z.literal('payment:completed'),
  paymentId: UuidSchema,
  status: z.enum(['AUTHORIZED', 'FAILED', 'EXPIRED']),
  timestamp: z.string().datetime(),
});
export type PaymentCompletedEvent = z.infer<typeof PaymentCompletedEventSchema>;

export const WsEventSchema = z.discriminatedUnion('type', [
  PaymentUpdateEventSchema,
  PaymentCompletedEventSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

// ─── FSM event types (transición interna) ───────────────────────────
export const FsmEventTypeSchema = z.enum([
  'QR_VIEWED',
  'AUTHORIZING',
  'AUTHORIZED',
  'POS_CONFIRMED',
  'FAILED',
  'TIMEOUT',
  'REFUND_PARTIAL',
  'CANCELED',
]);
export type FsmEventType = z.infer<typeof FsmEventTypeSchema>;
