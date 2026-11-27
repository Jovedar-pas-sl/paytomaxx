import { describe, it, expect } from 'vitest';
import { HttpException } from '@nestjs/common';
import { connectionIps, connectionState, expiryProblem, partnerReady, toConnectionAdminView, toPartnerOption } from './partner-rules';

const NOW = new Date('2026-12-05T10:00:00Z');
const DAY = 86_400_000;
const EGRESS = ['203.0.113.0/24', '2001:db8:42::/48'];

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return ((err as HttpException).getResponse() as { code: string }).code;
  }
};

describe('las IP de una clave', () => {
  it('sueltas y públicas, dentro de las del socio; se guardan limpias y sin repetir', () => {
    expect(connectionIps([' 203.0.113.7 ', '203.0.113.7/32', '2001:db8:42:1::/64'], EGRESS, ['wallet:load'], 'live')).toEqual([
      '203.0.113.7',
      '2001:db8:42:1::/64',
    ]);
  });

  it('una que no vale (rango, interna, Cloudflare): 422 PARTNER_IP_INVALID con la IP en el texto', () => {
    for (const bad of ['203.0.113.0/24', '10.0.0.1', '104.16.0.1']) {
      expect(codeOf(() => connectionIps([bad], EGRESS, ['wallet:balance'], 'test'))).toBe('PARTNER_IP_INVALID');
    }
    try {
      connectionIps(['10.0.0.1'], EGRESS, ['wallet:balance'], 'test');
    } catch (err) {
      expect(((err as HttpException).getResponse() as { message: string }).message).toMatch(/^10\.0\.0\.1 no vale/);
    }
  });

  it('fuera de las que declaró el socio: 422 PARTNER_IP_OUTSIDE (también una /64 más ancha que lo declarado)', () => {
    expect(codeOf(() => connectionIps(['198.51.100.7'], EGRESS, ['wallet:balance'], 'test'))).toBe('PARTNER_IP_OUTSIDE');
    expect(codeOf(() => connectionIps(['2001:db8:43::/64'], EGRESS, ['wallet:balance'], 'test'))).toBe('PARTNER_IP_OUTSIDE');
    expect(codeOf(() => connectionIps(['2001:db8:42:1::/64'], ['2001:db8:42:1::5'], ['wallet:balance'], 'test'))).toBe('PARTNER_IP_OUTSIDE');
  });

  it('en live, para cargar hacen falta; en la demo o sin cargar, no', () => {
    expect(codeOf(() => connectionIps([], EGRESS, ['wallet:load'], 'live'))).toBe('PARTNER_IP_REQUIRED');
    expect(connectionIps([], EGRESS, ['wallet:load'], 'test')).toEqual([]);
    expect(connectionIps([], EGRESS, ['wallet:balance'], 'live')).toEqual([]);
  });
});

describe('la caducidad', () => {
  it('de mañana a un año; obligatoria para cargar', () => {
    expect(expiryProblem(null, ['wallet:balance'], NOW)).toBe(false);
    expect(expiryProblem(null, ['wallet:load'], NOW)).toBe(true);
    expect(expiryProblem(new Date(NOW.getTime() + 2 * 3_600_000), ['wallet:load'], NOW)).toBe(true);
    expect(expiryProblem(new Date(NOW.getTime() + DAY), ['wallet:load'], NOW)).toBe(false);
    expect(expiryProblem(new Date(NOW.getTime() + 365 * DAY), ['wallet:load'], NOW)).toBe(false);
    expect(expiryProblem(new Date(NOW.getTime() + 366 * DAY), ['wallet:load'], NOW)).toBe(true);
  });
});

describe('el socio listo para dar claves', () => {
  const ready = {
    status: 'ACTIVE',
    kybCheckedAt: NOW,
    dataRole: 'PROCESSOR_OF_VENUE',
    dpaSignedAt: NOW,
    dpaVersion: 'v1',
    dataCountry: 'ES',
    transferMechanism: null,
  };
  it('activo, con KYB y contrato de datos; fuera del EEE, con el mecanismo de transferencia', () => {
    expect(partnerReady(ready)).toBe(true);
    for (const missing of ['kybCheckedAt', 'dataRole', 'dpaSignedAt', 'dpaVersion', 'dataCountry'] as const) {
      expect(partnerReady({ ...ready, [missing]: null }), missing).toBe(false);
    }
    expect(partnerReady({ ...ready, status: 'SUSPENDED' })).toBe(false);
    expect(partnerReady({ ...ready, dataCountry: 'US' })).toBe(false);
    expect(partnerReady({ ...ready, dataCountry: 'US', transferMechanism: 'Cláusulas contractuales tipo' })).toBe(true);
    expect(partnerReady({ ...ready, dataCountry: 'NO' })).toBe(true);
  });

  it('lo que ve el dueño: el techo dentro de lo que hoy se da, el correo tapado y nada más', () => {
    const option = toPartnerOption(
      { ...ready, id: 'p1', name: 'Cajeros', allowedScopes: ['reports:read', 'wallet:load', 'wallet:balance'], egressIps: ['203.0.113.0/24'], contactEmail: 'it@cajeros.es', channel: 'IN_VENUE' },
      ['wallet:balance', 'wallet:load'],
    );
    expect(option).toEqual({ id: 'p1', name: 'Cajeros', allowedScopes: ['wallet:balance', 'wallet:load'], egressIps: ['203.0.113.0/24'], contactEmail: expect.not.stringContaining('it@'), channel: 'in_venue' });
  });
});

describe('la vista de una conexión', () => {
  const base = {
    id: '11111111-2222-3333-4444-555555555555',
    partnerId: 'p1',
    status: 'ACTIVE',
    pausedReason: null,
    scopes: ['wallet:load', 'wallet:balance'],
    pausedScopes: [],
    keyMode: 'live',
    keyHint: 'oxp_live_…a1b2',
    keyCreatedAt: new Date(NOW.getTime() - 10 * DAY),
    keyExpiresAt: new Date(NOW.getTime() + 100 * DAY),
    prevKeyExpiresAt: null,
    keyExposedAt: null,
    keySuspendedAt: null,
    keyResumedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    ipAllowlist: ['203.0.113.7'],
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    partner: { name: 'Cajeros' },
  };

  it('el estado: anulada, caducada, dormida (marcada o 90 días), en pausa o activa', () => {
    expect(connectionState(base, NOW)).toBe('active');
    expect(connectionState({ ...base, status: 'REVOKED' }, NOW)).toBe('revoked');
    expect(connectionState({ ...base, keyExpiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe('expired');
    expect(connectionState({ ...base, keySuspendedAt: NOW }, NOW)).toBe('dormant');
    expect(connectionState({ ...base, keyCreatedAt: new Date(NOW.getTime() - 91 * DAY) }, NOW)).toBe('dormant');
    expect(connectionState({ ...base, status: 'PAUSED', pausedReason: 'owner' }, NOW)).toBe('paused');
  });

  it('sin hashes ni nada del enlace; quién la pausó; el id público', () => {
    const view = toConnectionAdminView({ ...base, pausedScopes: ['wallet:load'], pausedReason: 'foreign_ip', keyHash: 'f'.repeat(64), keyClaimSealed: 'x' } as never, [], NOW);
    expect(view).toMatchObject({ publicId: 'pc_11111111222233334444555555555555', pausedBy: 'foreign_ip', scopes: ['wallet:balance', 'wallet:load'], mode: 'live' });
    expect(JSON.stringify(view)).not.toMatch(/keyHash|keyClaim|ffffffff/);
  });
});
