import { z } from 'zod';
import { PartnerCurrencySchema, PartnerLoadIdSchema, PartnerTimestampSchema, partnerSchemas } from './common';
import { PartnerTermsSchema } from './connection';

// `POST /wallet/balance`: identificar un saldo (el código del móvil o la ficha)
// y leer su saldo. Esquemas Qr, NfcUid, WalletBalanceRequest y WalletBalance
// del contrato (docs/partner-api/pilot/openapi-piloto.yaml), que manda.

/** El código del móvil: `OXC1:` + 26 de base32 de Crockford (130 bits). */
export const LIVE_CODE_RE = /^OXC1:[0-9A-HJKMNP-TV-Z]{26}$/;

/** El `pattern` de NfcUid del contrato, carácter a carácter (4, 7 o 10 bytes). */
const NFC_UID_PATTERN =
  '^[0-9A-Fa-f]{2}(?:[-: ]?[0-9A-Fa-f]{2}){3}$|^[0-9A-Fa-f]{2}(?:[-: ]?[0-9A-Fa-f]{2}){6}$|^[0-9A-Fa-f]{2}(?:[-: ]?[0-9A-Fa-f]{2}){9}$';

export const PartnerQrSchema = z
  .string()
  .min(1)
  .max(512)
  .register(partnerSchemas, {
    id: 'Qr',
    description:
      'The exact text the QR scanner decoded, or the NDEF URI read from the ficha\'s chip with its URI prefix expanded\n(`https://…`), trimmed and otherwise unmodified. Never a typed code, a phone number, an internal id or a PIN.\n\nSend only texts that start with `OXC1:`, `NPF:` or `https://`, or that are exactly 6 letters or digits. For\nanything else (contact cards, Wi-Fi codes, other payment QRs, plain text) show the `wallet_ref_unrecognized`\ntext without calling OxioPay.\n\nAccepted:\n- a **live code** `OXC1:` + 26 Crockford base32 characters, shown on the customer\'s own wallet page under\n  "Pagar o recargar en otro sistema". In this pilot it identifies only (balance and loads) and lives 60 seconds;\n- a **ficha link** `https://<host>/?ficha=<token>` as written on the chip (or printed as a QR).\n\nRefused with `422 wallet_ref_not_accepted`, with `reason`: the Google Wallet pass `https://<host>/c/…`\n(`wallet_pass`); the wallet\'s own private link `/w/<token>` and its sub-pages (`private_link`); the reception QR\n`NPF:…` (`reception_qr`); the 6-character wallet code, or a link carrying `?saldo=` (`short_code`); charge links\n`/s/…`, `/pay/…` (`charge_link`); activation `/w/a/…`, the ficha\'s own page `/w/card/…`, `/w/salida/…`,\n`/w/no/…`, reservation and gift links (`other_link`). The refusal and its `reason` depend only on the text\'s\nshape: the same answer whether the link or code is valid, unknown or of another company. Anything else →\n`422 wallet_ref_unrecognized`. An expired or unknown live code → `422 live_code_invalid`.\n\nNever store or log it.\n',
    'x-decided-in-contract': true,
    examples: ['OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9', 'https://demo-operator.oxiopay.example/?ficha=demo-ficha-uid-0000001'],
  });

export const PartnerNfcUidSchema = z
  .string()
  .regex(new RegExp(NFC_UID_PATTERN))
  .register(partnerSchemas, {
    id: 'NfcUid',
    description:
      'The chip\'s serial (UID, ISO/IEC 14443-3) in hex: 4, 7 or 10 bytes, in the order the chip sends them during\nanticollision. That is the order Android\'s `Tag.getId()` and PC/SC `GET DATA` (`FF CA 00 00 00`) return, and\nthe order OxioPay stores: the venues\' NTAG213/215/216 fichas have 7 bytes starting with `04`\n(`04A1B2C3D4E5F6`). With or without `:`, `-` or a space between bytes; case is ignored. Never reversed and\nnever as a decimal number: a serial in another form does not match the stored one, answers\n`409 ficha_copy_suspected` and raises an alert to the owner.\n\nSend it whenever the ficha was read by NFC, and only then: with a live code it answers `422 validation_failed`\n(`param: "nfc_uid"`). When OxioPay holds a different serial for that ficha → `409 ficha_copy_suspected`. A\nficha without a stored serial, or a ficha link sent without `nfc_uid`, is treated as a plain ficha link (a\ncopy cannot be detected then). OxioPay never stores the serial you send. Never store or log it beyond the\ntransaction.\n',
    'x-decided-in-contract': true,
    examples: ['04A1B2C3D4E5F6'],
  });

export const WalletBalanceRequest = z
  .strictObject({ qr: PartnerQrSchema, nfc_uid: PartnerNfcUidSchema.optional() })
  .register(partnerSchemas, { id: 'WalletBalanceRequest' });
export type WalletBalanceRequestBody = z.infer<typeof WalletBalanceRequest>;

export const WalletBalance = z
  .object({
    object: z.literal('wallet_balance'),
    available: z.number().int().min(0).register(partnerSchemas, { description: 'The live wallet\'s balance in cents (0 when it is empty).' }),
    currency: PartnerCurrencySchema,
    livemode: z.boolean(),
  })
  .register(partnerSchemas, { id: 'WalletBalance', description: 'Nothing else is ever returned about the wallet.' });
export type WalletBalanceBody = z.infer<typeof WalletBalance>;

/** Los `reason` de `422 wallet_ref_not_accepted` (sin `venue_setting`, que es de la carga). */
export type WalletRefReason = 'wallet_pass' | 'private_link' | 'reception_qr' | 'short_code' | 'charge_link' | 'other_link';

const refDetail = (en: string, es: string) => ({
  en: `This is ${en} and it is never accepted. Ask for the code under "Pagar o recargar en otro sistema".`,
  es: `Es ${es} y nunca se acepta. Pide el código de «Pagar o recargar en otro sistema».`,
});

/** El `detail` de `422 wallet_ref_not_accepted` según su `reason`. */
export const WALLET_REF_DETAIL: Readonly<Record<WalletRefReason, { readonly en: string; readonly es: string }>> = {
  wallet_pass: refDetail('the customer\'s Google Wallet pass', 'el pase de Google Wallet del cliente'),
  private_link: refDetail('the customer\'s private wallet link', 'el enlace privado del saldo del cliente'),
  reception_qr: refDetail('the reception QR', 'el QR de recepción'),
  short_code: refDetail('the 6-character wallet code', 'el código de 6 caracteres del saldo'),
  charge_link: refDetail('a charge link', 'el enlace de un cobro'),
  other_link: refDetail('an OxioPay link that is not a wallet', 'un enlace de OxioPay que no es un saldo'),
};

// ─── Cargas (PR 3): POST /wallet/loads, leerla, anularla, listar y el resumen ─

/** La transacción de una carga o anulación: espera al pool y lo que puede durar. */
export const LOAD_TX = { maxWait: 5_000, timeout: 20_000 } as const;
/** Una carga se guarda en los 25 s siguientes a llegar o nunca (el contrato da 30). */
export const LOAD_DEADLINE_MS = 25_000;
/** El socio anula sus cargas hasta 10 minutos después (`void_until`). */
export const LOAD_VOID_WINDOW_MS = 10 * 60_000;
/** El dueño y el encargado, desde el panel, hasta 36 horas (pregunta 12). */
export const LOAD_PANEL_VOID_WINDOW_MS = 36 * 3_600_000;
/** Cargas por saldo y minuto de una conexión (`np:prl:wload`). */
export const LOADS_PER_WALLET_MINUTE = 6;
/** Longitudes de los textos del socio, en puntos de código y ya limpios. */
export const PARTNER_DESCRIPTION_MAX = 60;
export const PARTNER_REASON_MAX = 140;

export const PARTNER_FUNDINGS = ['cash', 'card', 'transfer', 'bank_app'] as const;
export type PartnerFunding = (typeof PARTNER_FUNDINGS)[number];

export const PartnerFundingSchema = z.enum(PARTNER_FUNDINGS).register(partnerSchemas, {
  id: 'Funding',
  description:
    "How the customer paid the load. Under `venue_collects` only `cash` and `card` (a payment on the venue's own\ncard terminal) are accepted; `transfer` and `bank_app` belong to agent models → `422 funding_not_allowed`.\n**ATM pilot: only `cash`.** `card` answers `422 funding_not_allowed` until OxioPay enables it for the connection.\n",
  'x-decided-in-contract': true,
});

/** Sin `.max()`: la longitud se mira limpia y en puntos de código (el servicio, tras la clave). */
export const PartnerDescriptionSchema = z.string().register(partnerSchemas, {
  id: 'Description',
  minLength: 1,
  maxLength: PARTNER_DESCRIPTION_MAX,
  description:
    'Required. 1 to 60 Unicode code points after trimming, NFC normalisation and collapsing inner whitespace (send it\nalready normalised). The customer sees it as "Carga · {partner_name}: {description}" in their movements\n("Top-up · …" on a page in English); the owner sees it in the panel.\n\n`422 description_invalid`: control or format characters (zero-width characters, bidi overrides U+202A–U+202E\nand U+2066–U+2069, U+FEFF), line or paragraph separators, `<` or `>`, URLs or domains (`://`, `www.`,\n`word.tld`).\n`422 description_personal_data`: anything that looks like an email; 9 or more digits in a row once spaces,\ndots, dashes, `·` and `/` are removed (phones, card numbers, long serial numbers); any run of 13 to 19 digits\nthat passes the Luhn check. Never write anything that reveals a personal service.\n',
  examples: ['Recarga en cajero 0042'],
});

export const PARTNER_REFERENCE_RE = /^[A-Za-z0-9._:/#-]{1,64}$/;
export const PartnerReferenceSchema = z
  .string()
  .regex(PARTNER_REFERENCE_RE)
  .register(partnerSchemas, {
    id: 'Reference',
    description:
      'Your own id for the operation (use the ATM transaction id). Never personal data: no card number, phone, email\nor name; a run of 13 to 19 digits that passes the Luhn check → `422 validation_failed` (`param: "reference"`).\nNever shown to the customer; searchable by the owner; not unique.\n',
    'x-decided-in-contract': true,
    examples: ['ATM0042-20261205-000731-K7QM'],
  });

export const PartnerDeviceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .register(partnerSchemas, {
    id: 'Device',
    description:
      'The ATM that took the money (for example `ATM0042`). Send it on every load. It is part of the request for\nidempotency, is stored with the load and is shown to the owner, never to the customer. OxioPay watches cash\nsplit across several wallets per ATM with it.\n',
    'x-decided-in-contract': true,
    examples: ['ATM0042'],
  });

/** La `Idempotency-Key` del contrato (8 a 200 de `[A-Za-z0-9_-]`). */
export const PARTNER_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;

export const WalletLoadRequest = z
  .strictObject({
    qr: PartnerQrSchema,
    nfc_uid: PartnerNfcUidSchema.optional(),
    amount: z
      .number()
      .int()
      .min(1)
      .max(99999)
      .register(partnerSchemas, { description: "Cents, from 1 to 99999 (999.99 €). The connection's limits apply on top." }),
    description: PartnerDescriptionSchema,
    reference: PartnerReferenceSchema.optional(),
    funding: PartnerFundingSchema,
    device: PartnerDeviceSchema.optional(),
  })
  .register(partnerSchemas, { id: 'WalletLoadRequest' });
export type WalletLoadRequestBody = z.infer<typeof WalletLoadRequest>;

export const WalletLoad = z
  .object({
    object: z.literal('wallet_load'),
    id: PartnerLoadIdSchema,
    status: z.enum(['succeeded', 'voided']),
    amount: z.number().int().min(1).max(99999),
    currency: PartnerCurrencySchema,
    description: z.string().register(partnerSchemas, { description: 'The description as stored (normalised).' }),
    reference: z
      .string()
      .nullable()
      .register(partnerSchemas, { description: 'Your reference, or null when none was sent.', 'x-decided-in-contract': true }),
    funding: PartnerFundingSchema,
    device: z.string().nullable().register(partnerSchemas, { description: 'The ATM you sent in `device`, or null when none was sent.' }),
    created_at: PartnerTimestampSchema,
    void_until: PartnerTimestampSchema,
    balance_after: z
      .number()
      .int()
      .min(1)
      .register(partnerSchemas, {
        description:
          "The wallet's balance right after this load was made, in cents, as stored then. It does not change with a\nvoid or later movements, so the read and void answers repeat it. Only when the key holds `wallet:balance`.\n",
      })
      .optional(),
    terms: PartnerTermsSchema,
    voided_at: z.iso
      .datetime()
      .nullable()
      .register(partnerSchemas, {
        description: 'In the answers of `GET /wallet/loads/{id}`, the void and the list (null while not voided). Not in the create answer.',
        'x-decided-in-contract': true,
      })
      .optional(),
    livemode: z.boolean(),
  })
  .register(partnerSchemas, { id: 'WalletLoad', 'x-decided-in-contract': true });
export type WalletLoadBody = z.infer<typeof WalletLoad>;

/** Sin `.max()`: `reason` se mira limpia, en puntos de código, de 1 a 140 (el servicio). */
export const WalletLoadVoidRequest = z
  .strictObject({
    reason: z
      .string()
      .register(partnerSchemas, {
        minLength: 1,
        maxLength: PARTNER_REASON_MAX,
        description:
          'Optional. Why the load is voided, for the venue. Same text rules as `description`, but a broken rule\nanswers `422 validation_failed` (`param: "reason"`). Never shown to the customer.\n',
        'x-decided-in-contract': true,
      })
      .optional(),
  })
  .register(partnerSchemas, { id: 'WalletLoadVoidRequest' });
export type WalletLoadVoidRequestBody = z.infer<typeof WalletLoadVoidRequest>;

export const WalletLoadList = z
  .object({
    object: z.literal('list'),
    data: z.array(WalletLoad),
    has_more: z.boolean(),
    next_cursor: z
      .string()
      .nullable()
      .register(partnerSchemas, { description: 'Pass it as `cursor` to read the next page; null on the last page.' }),
  })
  .register(partnerSchemas, { id: 'WalletLoadList' });
export type WalletLoadListBody = z.infer<typeof WalletLoadList>;

export const CountAmount = z
  .object({
    count: z.number().int().min(0),
    amount: z.number().int().min(0).register(partnerSchemas, { description: 'Cents.' }),
  })
  .register(partnerSchemas, { id: 'CountAmount' });

export const Statement = z
  .object({
    object: z.literal('statement'),
    from: PartnerTimestampSchema,
    to: PartnerTimestampSchema,
    currency: PartnerCurrencySchema,
    livemode: z.boolean(),
    loads: z
      .object({
        count: z.number().int().min(0),
        amount: z.number().int().min(0),
        by_funding: z.object({ cash: CountAmount, card: CountAmount, transfer: CountAmount, bank_app: CountAmount }),
      })
      .register(partnerSchemas, { description: "This connection's loads created in the period." }),
    load_voids: CountAmount,
    net_loads: z.number().int().register(partnerSchemas, {
      description: '`loads.amount` − `load_voids.amount`, in cents (negative when the period holds voids of earlier loads).',
    }),
  })
  .register(partnerSchemas, { id: 'Statement', 'x-decided-in-contract': true });
export type StatementBody = z.infer<typeof Statement>;

// ─── Las consultas de /wallet/operations y /statement (puras) ────────────

/** Una consulta que no vale: el código y el parámetro (el primero en el orden del contrato). */
export interface PartnerQueryFault {
  ok: false;
  code: 'validation_failed' | 'range_too_long';
  param?: string;
  /** El tope del periodo, en días (range_too_long). */
  maxDays?: number;
}

export interface OperationsQuery {
  ok: true;
  from: Date;
  to: Date;
  /** La noche pedida (si se pidió por noche). */
  businessDate: string | null;
  reference: string | null;
  limit: number;
  cursor: string | null;
}

export interface StatementQuery {
  ok: true;
  from: Date;
  to: Date;
}

const OffsetDateTime = z.iso.datetime({ offset: true });
const DAY_MS = 86_400_000;
export const OPERATIONS_MAX_DAYS = 31;
export const STATEMENT_MAX_DAYS = 92;

type Query = Readonly<Record<string, unknown>>;
const fault = (param: string): PartnerQueryFault => ({ ok: false, code: 'validation_failed', param });

/** Un parámetro de texto (repetido o vacío: no vale). undefined = no está. */
function text(q: Query, name: string): string | undefined | null {
  const v = q[name];
  if (v === undefined) return undefined;
  return typeof v === 'string' && v !== '' ? v : null;
}

function instant(q: Query, name: string): Date | undefined | null {
  const v = text(q, name);
  if (v === undefined || v === null) return v;
  return OffsetDateTime.safeParse(v).success ? new Date(v) : null;
}

/** `YYYY-MM-DD` de un día que existe. */
export function isBusinessDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * `GET /wallet/operations`: `business_date` o `from` y `to` (hasta 31 días),
 * `reference` exacta, `type` solo `load`, `limit` 1–100 (25) y `cursor`.
 * `nightOf(día)` da la noche (08:00 a 08:00 de Madrid): la pone quien llama.
 */
export function parseOperationsQuery(q: Query, nightOf: (day: string) => { from: Date; to: Date }): OperationsQuery | PartnerQueryFault {
  const day = text(q, 'business_date');
  const hasFrom = q.from !== undefined;
  const hasTo = q.to !== undefined;
  let from: Date;
  let to: Date;
  let businessDate: string | null = null;
  if (day !== undefined) {
    if (hasFrom || hasTo) return fault(hasFrom ? 'from' : 'to');
    if (day === null || !isBusinessDate(day)) return fault('business_date');
    ({ from, to } = nightOf(day));
    businessDate = day;
  } else {
    if (!hasFrom && !hasTo) return fault('business_date');
    if (!hasFrom) return fault('from');
    if (!hasTo) return fault('to');
    const f = instant(q, 'from');
    if (!f) return fault('from');
    const t = instant(q, 'to');
    if (!t) return fault('to');
    if (t.getTime() <= f.getTime()) return fault('to');
    if (t.getTime() - f.getTime() > OPERATIONS_MAX_DAYS * DAY_MS) return { ok: false, code: 'range_too_long', maxDays: OPERATIONS_MAX_DAYS };
    from = f;
    to = t;
  }
  const reference = text(q, 'reference');
  if (reference === null || (reference !== undefined && !PARTNER_REFERENCE_RE.test(reference))) return fault('reference');
  const type = text(q, 'type');
  if (type !== undefined && type !== 'load') return fault('type');
  const rawLimit = text(q, 'limit');
  let limit = 25;
  if (rawLimit !== undefined) {
    if (rawLimit === null || !/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) return fault('limit');
    limit = Number(rawLimit);
  }
  const cursor = text(q, 'cursor');
  if (cursor === null || (cursor !== undefined && cursor.length > 512)) return fault('cursor');
  return { ok: true, from, to, businessDate, reference: reference ?? null, limit, cursor: cursor ?? null };
}

/** `GET /statement`: `from` y `to` obligatorios (`from` entra, `to` no), hasta 92 días. */
export function parseStatementQuery(q: Query): StatementQuery | PartnerQueryFault {
  if (q.from === undefined) return fault('from');
  if (q.to === undefined) return fault('to');
  const from = instant(q, 'from');
  if (!from) return fault('from');
  const to = instant(q, 'to');
  if (!to) return fault('to');
  if (to.getTime() <= from.getTime()) return fault('to');
  if (to.getTime() - from.getTime() > STATEMENT_MAX_DAYS * DAY_MS) return { ok: false, code: 'range_too_long', maxDays: STATEMENT_MAX_DAYS };
  return { ok: true, from, to };
}
