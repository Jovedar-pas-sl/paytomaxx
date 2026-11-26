import { z } from 'zod';
import { LOAD_CAPS, LOAD_LIMITS_FIXED, PartnerScopeSchema, partnerSchemas } from './common';

// `GET /me`: la conexión de la clave (esquema `Connection` del contrato).

export const PartnerIssuerSchema = z
  .object({
    legal_name: z.string().register(partnerSchemas, {
      description:
        'The company\'s legal name, as registered in OxioPay. A key is only issued for a venue whose company has a tax id on file. If the venue later has no company, belongs to another company than when the key was issued, or its company has no tax id, every route of the connection answers `403 connection_paused` until OxioPay fixes it: an answer never comes without `issuer`. A deleted venue answers `401 api_key_revoked`.',
    }),
    tax_id: z.string().register(partnerSchemas, { description: 'The company\'s tax id (NIF/CIF), uppercase, without spaces or dashes.' }),
  })
  .register(partnerSchemas, {
    id: 'Issuer',
    description: 'The company that issues the balance (the venue\'s company). OxioPay is its technical provider. Print it on the ticket.',
    'x-decided-in-contract': true,
  });

export const PartnerKeyInfoSchema = z
  .object({
    hint: z
      .string()
      .regex(/^oxp_(live|test)_…[0-9a-f]{4}$/)
      .register(partnerSchemas, { description: 'The prefix and last 4 characters of the key you sent (during an overlap, the old key\'s own).' }),
    expires_at: z.iso.datetime().nullable().register(partnerSchemas, {
      description:
        'When this key stops working (at most 365 days after its creation; always set for a key with `wallet:load`). During a rotation overlap, the end of the overlap. To renew before it, ask the owner for a rotation with a 7-day overlap at least 30 days before.',
    }),
    replaced: z.boolean().register(partnerSchemas, {
      description:
        '`true` when the owner has rotated this key: a new key was sent through the one-time claim link and this one works only until `expires_at`. Alert your operators at once.',
    }),
  })
  .register(partnerSchemas, { id: 'KeyInfo', 'x-decided-in-contract': true });

const capCents = (max: number, description: string) =>
  z.number().int().min(1).max(max).register(partnerSchemas, { description });

export const PartnerLoadLimitsSchema = z
  .object({
    per_operation: capCents(LOAD_CAPS.perOperation.max, 'Most one load may carry. Default 30000 (300 €); the owner may set up to 99999.'),
    wallet_24h: capCents(
      LOAD_CAPS.walletDay.max,
      'Loads minus voids by this connection into one wallet (with the wallets merged into it) in the last 24 hours. Default 60000; owner up to 99999.',
    ),
    wallet_24h_all_partners: z.literal(LOAD_LIMITS_FIXED.wallet_24h_all_partners).register(partnerSchemas, {
      description: 'Loads minus voids by every partner into one wallet in the last 24 hours, any funding. Fixed.',
    }),
    unnamed_wallet_30d: z.literal(LOAD_LIMITS_FIXED.unnamed_wallet_30d).register(partnerSchemas, {
      description:
        'Loads minus voids by this partner (all its connections) into one wallet without a contact phone, in the last 30 days, any funding. Fixed at 1,500 €. Above it the customer asks the venue\'s manager to record their phone.',
    }),
    connection_night: capCents(
      LOAD_CAPS.night.max,
      'Loads minus voids by this connection in the venue\'s current night. Default 500000; owner up to 5000000.',
    ),
    cash_wallet_24h: z.literal(LOAD_LIMITS_FIXED.cash_wallet_24h).register(partnerSchemas, {
      description:
        'Cash into one wallet in the last 24 hours, counting reception and every partner together (Ley 7/2012). Fixed. The total can never reach 100000.',
    }),
  })
  .register(partnerSchemas, {
    id: 'LoadLimits',
    description:
      'The limits that apply to this connection\'s loads, in cents. Each one is also the `limit` value of `402 limit_exceeded`, except `cash_wallet_24h`, whose refusal is `402 cash_limit_reached`.',
    'x-decided-in-contract': true,
  });

export const PartnerLimitsSchema = z.object({ loads: PartnerLoadLimitsSchema }).register(partnerSchemas, { id: 'Limits' });

export const PartnerTermsSchema = z
  .object({
    url: z.url().register(partnerSchemas, { description: 'The balance section of OxioPay\'s Conditions page.' }),
    version: z.string().register(partnerSchemas, { description: 'The revision date of the terms (YYYY-MM-DD).' }),
    summary_es: z.string(),
    summary_en: z.string(),
  })
  .register(partnerSchemas, {
    id: 'Terms',
    description:
      'The balance terms. The ATM shows `summary_es` or `summary_en` (the customer\'s language) from `GET /me` on screen before taking the money, and prints the `terms` of the load answer (summary, `url` and `version`) on the ticket. The summary, `url` and `version` always come from OxioPay, never from a copy kept in the ATM\'s code.',
    'x-decided-in-contract': true,
  });

/** Lista de permisos sin repetidos (el generador la publica con `uniqueItems`). */
export const PartnerScopeListSchema = z.array(PartnerScopeSchema);

export const PartnerConnectionSchema = z
  .object({
    object: z.literal('connection'),
    id: z.string().regex(/^pc_[0-9a-f]{32}$/),
    partner_name: z.string().max(30).register(partnerSchemas, {
      description: 'The partner\'s name as customers see it ("Carga · {partner_name}: {description}").',
    }),
    venue_name: z.string().register(partnerSchemas, { description: 'The venue this key belongs to.' }),
    issuer: PartnerIssuerSchema,
    collection_model: z.enum(['venue_collects', 'partner_agent', 'licensed_psp']).register(partnerSchemas, {
      description: 'Who collects the money of a load. The ATM pilot is `venue_collects`: the cash belongs to the venue.',
    }),
    channel: z.enum(['in_venue', 'online']),
    status: z.enum(['active', 'paused', 'revoked']).register(partnerSchemas, {
      description: 'Always `active` in an answer; a paused or revoked connection is refused before.',
    }),
    scopes: PartnerScopeListSchema,
    paused_scopes: PartnerScopeListSchema,
    livemode: z.boolean(),
    key: PartnerKeyInfoSchema,
    limits: PartnerLimitsSchema,
    terms: PartnerTermsSchema,
  })
  .register(partnerSchemas, {
    id: 'Connection',
    description:
      'In this pilot the connection carries no `credit` block (agent models only) and no `webhook` block (webhooks come after the pilot); both will be added without breaking anything.',
    'x-decided-in-contract': true,
  });
export type PartnerConnection = z.infer<typeof PartnerConnectionSchema>;
