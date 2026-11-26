import { z } from 'zod';
import { PartnerCurrencySchema, partnerSchemas } from './common';

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
