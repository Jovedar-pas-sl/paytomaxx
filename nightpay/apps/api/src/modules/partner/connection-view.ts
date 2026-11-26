import { LOAD_LIMITS_FIXED, PARTNER_TERMS, publicId, type PartnerConnection } from '@nightpay/contracts';
import { LOCAL_API_ORIGIN, originOf } from '../home-topup/home-topup-settings.service';
import { LEGAL_UPDATED } from '../legal/legal-owner';
import type { PartnerAuth } from './auth/current-connection.decorator';

/** El apartado del saldo de las Condiciones, en el host público del API. */
export function partnerTermsUrl(apiUrl: string | undefined): string {
  return new URL('/legal/condiciones#saldo', originOf(apiUrl) ?? LOCAL_API_ORIGIN).toString();
}

/**
 * GET /me: la conexión de la clave como la publica el contrato (Connection).
 * Los enums en minúsculas; los permisos, los de la clave dentro del techo del
 * socio; el emisor, la sociedad del local (el guard ya cortó si no tiene NIF).
 * Durante el solape de una rotación, con la clave vieja: `replaced` y el fin
 * del solape.
 */
export function toConnectionView(auth: PartnerAuth, termsUrl: string): PartnerConnection {
  const c = auth.connection;
  const previous = auth.keyMatch === 'previous';
  return {
    object: 'connection',
    id: publicId('pc', c.id),
    partner_name: c.partner.name,
    venue_name: c.venue.name,
    issuer: { legal_name: c.venue.business?.name ?? '', tax_id: c.venue.business?.taxId ?? '' },
    collection_model: c.collectionModel.toLowerCase() as PartnerConnection['collection_model'],
    channel: c.channel.toLowerCase() as PartnerConnection['channel'],
    status: 'active',
    scopes: auth.effectiveScopes,
    paused_scopes: auth.effectiveScopes.filter((s) => c.pausedScopes.includes(s)),
    livemode: c.keyMode === 'live',
    key: {
      hint: auth.keyHint,
      expires_at: (previous ? c.prevKeyExpiresAt : c.keyExpiresAt)?.toISOString() ?? null,
      replaced: previous,
    },
    limits: {
      loads: {
        per_operation: c.loadPerOpMaxCents,
        wallet_24h: c.loadWalletDayMaxCents,
        wallet_24h_all_partners: LOAD_LIMITS_FIXED.wallet_24h_all_partners,
        unnamed_wallet_30d: LOAD_LIMITS_FIXED.unnamed_wallet_30d,
        connection_night: c.loadNightMaxCents,
        cash_wallet_24h: LOAD_LIMITS_FIXED.cash_wallet_24h,
      },
    },
    terms: { url: termsUrl, version: LEGAL_UPDATED, ...PARTNER_TERMS },
  };
}
