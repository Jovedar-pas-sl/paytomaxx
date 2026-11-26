import { describe, it, expect } from 'vitest';
import { LOAD_LIMITS_FIXED, PARTNER_TERMS, PartnerConnectionSchema } from '@nightpay/contracts';
import type { PartnerAuth } from './auth/current-connection.decorator';
import { partnerTermsUrl, toConnectionView } from './connection-view';

const NOW = new Date('2026-12-05T22:00:00Z');

function auth(over: Partial<PartnerAuth> = {}, conn: Record<string, unknown> = {}): PartnerAuth {
  return {
    keyMatch: 'current',
    keyHint: 'oxp_live_…ab12',
    effectiveScopes: ['wallet:balance', 'wallet:load'],
    connection: {
      id: '11111111-2222-3333-4444-555555555555',
      collectionModel: 'VENUE_COLLECTS',
      channel: 'IN_VENUE',
      pausedScopes: ['wallet:load'],
      keyMode: 'live',
      keyExpiresAt: new Date(NOW.getTime() + 300 * 86_400_000),
      prevKeyExpiresAt: new Date(NOW.getTime() + 86_400_000),
      loadPerOpMaxCents: 30000,
      loadWalletDayMaxCents: 60000,
      loadNightMaxCents: 500000,
      partner: { name: 'Cajeros Demo' },
      venue: { name: 'Local Demo Centro', business: { name: 'Empresa Demo S.L.', taxId: 'B00000000' } },
      ...conn,
    } as never,
    ...over,
  };
}

describe('GET /me: la conexión como la publica el contrato', () => {
  it('cumple el esquema Connection: id pc_, enums en minúsculas, emisor, topes y condiciones', () => {
    const terms = partnerTermsUrl('https://api.oxiopay.example/v1');
    const view = PartnerConnectionSchema.parse(toConnectionView(auth(), terms));
    expect(view).toMatchObject({
      object: 'connection',
      id: 'pc_11111111222233334444555555555555',
      collection_model: 'venue_collects',
      channel: 'in_venue',
      status: 'active',
      livemode: true,
      issuer: { legal_name: 'Empresa Demo S.L.', tax_id: 'B00000000' },
      scopes: ['wallet:balance', 'wallet:load'],
      paused_scopes: ['wallet:load'],
      key: { hint: 'oxp_live_…ab12', replaced: false },
      limits: { loads: { per_operation: 30000, wallet_24h: 60000, connection_night: 500000, ...LOAD_LIMITS_FIXED } },
      terms: { url: 'https://api.oxiopay.example/legal/condiciones#saldo', ...PARTNER_TERMS },
    });
  });

  it('en pausa solo lo que la clave tiene hoy; con la clave vieja del solape, replaced y su fin', () => {
    const view = toConnectionView(
      auth({ keyMatch: 'previous', effectiveScopes: ['wallet:balance'] }, { keyMode: 'test' }),
      partnerTermsUrl(undefined),
    );
    expect(view.paused_scopes).toEqual([]);
    expect(view.livemode).toBe(false);
    expect(view.key).toEqual({ hint: 'oxp_live_…ab12', replaced: true, expires_at: new Date(NOW.getTime() + 86_400_000).toISOString() });
    expect(view.terms.url).toBe('http://localhost:4100/legal/condiciones#saldo');
  });

  it('sin caducidad, expires_at null', () => {
    expect(toConnectionView(auth({}, { keyExpiresAt: null }), 'https://x/legal').key.expires_at).toBeNull();
  });
});
