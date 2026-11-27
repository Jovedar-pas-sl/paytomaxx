import { describe, expect, it } from 'vitest';
import type { PartnerConnectionView, PartnerKeyIssued, PartnerOptionView } from '@nightpay/contracts';
import {
  CHANGE_KEY_LABEL,
  OVERLAP_CHOICES,
  PAUSED_BY_OXIOPAY_LABEL,
  connectionActions,
  connectionNotices,
  connectionTag,
  createPayload,
  deliveryChoices,
  expiryBounds,
  expiryRequired,
  expiryToIso,
  issuedOutcome,
  rotatePayload,
  splitPartnerIps,
  suggestedOverlap,
  type ConnectForm,
} from './partner-connections';

// «Otras plataformas» (Ajustes): lo que el panel decide antes de llamar al API
// (/v1/admin/partner-connections). El API vuelve a comprobarlo todo; aquí se
// evita mandar lo que seguro que rechaza y se dice en llano.

const NOW = new Date(2026, 10, 26, 18, 30); // 26-nov-2026, 18:30 hora local

function conn(over: Partial<PartnerConnectionView> = {}): PartnerConnectionView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    publicId: 'pc_11111111111141118111111111111111',
    partnerId: '22222222-2222-4222-8222-222222222222',
    partnerName: 'Cajeros Demo',
    state: 'active',
    pausedBy: null,
    scopes: ['wallet:balance', 'wallet:load'],
    pausedScopes: [],
    mode: 'live',
    keyHint: 'oxp_live_…a1b2',
    keyCreatedAt: '2026-11-20T10:00:00.000Z',
    keyExpiresAt: '2027-11-19T22:59:00.000Z',
    previousKeyUntil: null,
    keyExposedAt: null,
    keySuspendedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    ipAllowlist: ['203.0.113.7'],
    foreignIps: [],
    limits: { perOperationCents: 30000, walletDayCents: 60000, nightCents: 500000 },
    createdAt: '2026-11-20T10:00:00.000Z',
    ...over,
  };
}

const partner: PartnerOptionView = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Cajeros Demo',
  allowedScopes: ['wallet:balance', 'wallet:load'],
  egressIps: ['203.0.113.7', '203.0.113.8', '198.51.100.0/24', '2001:db8:1:2::/64', '2001:db8::/48'],
  contactEmail: 'o***@cajeros.example',
  channel: 'in_venue',
};

function form(over: Partial<ConnectForm> = {}): ConnectForm {
  return {
    partnerId: partner.id,
    scopes: ['wallet:balance', 'wallet:load'],
    ips: ['203.0.113.7'],
    noExpiry: false,
    expiryDay: '2027-06-30',
    delivery: 'copy',
    ...over,
  };
}

describe('el estado de cada conexión, en una etiqueta', () => {
  it('activa, en pausa, dormida, caducada y anulada', () => {
    expect(connectionTag(conn())).toEqual({ tone: 'success', label: 'Activa' });
    expect(connectionTag(conn({ state: 'paused', pausedBy: 'owner' }))).toEqual({ tone: 'warning', label: 'En pausa' });
    expect(connectionTag(conn({ state: 'dormant' }))).toEqual({ tone: 'neutral', label: 'Dormida' });
    expect(connectionTag(conn({ state: 'expired' }))).toEqual({ tone: 'danger', label: 'Caducada' });
    expect(connectionTag(conn({ state: 'revoked' }))).toEqual({ tone: 'neutral', label: 'Anulada' });
  });

  it('la pausa de OxioPay se dice así, «En pausa por OxioPay»', () => {
    expect(PAUSED_BY_OXIOPAY_LABEL).toBe('En pausa por OxioPay');
    expect(connectionTag(conn({ state: 'paused', pausedBy: 'oxiopay' }))).toEqual({ tone: 'warning', label: 'En pausa por OxioPay' });
  });

  it('las cargas en pausa por usarla desde otra IP (la conexión sigue activa para lo demás)', () => {
    expect(connectionTag(conn({ pausedBy: 'foreign_ip', pausedScopes: ['wallet:load'] }))).toEqual({
      tone: 'danger',
      label: 'En pausa: usada desde otra IP',
    });
  });
});

describe('qué botones hay', () => {
  it('el dueño: cambiar la clave, pausar y anular; reanudar si está en pausa o dormida', () => {
    expect(connectionActions(conn(), 'OWNER')).toEqual(['rotate', 'pause', 'revoke']);
    expect(connectionActions(conn({ state: 'paused', pausedBy: 'manager' }), 'OWNER')).toEqual(['resume', 'rotate', 'revoke']);
    expect(connectionActions(conn({ pausedBy: 'foreign_ip', pausedScopes: ['wallet:load'] }), 'OWNER')).toEqual([
      'resume',
      'rotate',
      'revoke',
    ]);
    expect(connectionActions(conn({ state: 'dormant' }), 'OWNER')).toEqual(['resume', 'rotate', 'revoke']);
    expect(connectionActions(conn({ state: 'expired' }), 'OWNER')).toEqual(['rotate', 'revoke']);
  });

  it('la pausa de OxioPay no la quita el dueño (solo la consola)', () => {
    expect(connectionActions(conn({ state: 'paused', pausedBy: 'oxiopay' }), 'OWNER')).not.toContain('resume');
    expect(connectionActions(conn({ state: 'dormant', pausedBy: 'oxiopay' }), 'OWNER')).not.toContain('resume');
  });

  it('el encargado solo pausa y anula', () => {
    expect(connectionActions(conn(), 'MANAGER')).toEqual(['pause', 'revoke']);
    expect(connectionActions(conn({ state: 'paused', pausedBy: 'owner' }), 'MANAGER')).toEqual(['revoke']);
    expect(connectionActions(conn({ state: 'dormant' }), 'MANAGER')).toEqual(['revoke']);
  });

  it('anulada: nada', () => {
    expect(connectionActions(conn({ state: 'revoked' }), 'OWNER')).toEqual([]);
    expect(connectionActions(conn({ state: 'revoked' }), 'MANAGER')).toEqual([]);
  });
});

describe('una IP ajena o la clave en una dirección web llevan a «Cambiar clave» con «Nada» marcado', () => {
  it('el aviso, con las IP y el botón solo para el dueño', () => {
    const c = conn({ foreignIps: [{ ip: '192.0.2.50', at: '2026-11-26T17:00:00.000Z' }] });
    const [notice] = connectionNotices(c, 'OWNER');
    expect(notice).toMatchObject({ tone: 'danger', title: 'Clave usada desde otra IP', action: CHANGE_KEY_LABEL });
    expect(notice!.text).toContain('192.0.2.50');
    expect(notice!.text).toContain('Se rechazó una clave usada desde una IP ajena: si no es de la plataforma, cámbiala.');
    expect(connectionNotices(c, 'MANAGER')[0]!.action).toBeNull();
    expect(suggestedOverlap(c)).toBe('none');
  });

  it('la clave en una dirección web', () => {
    const c = conn({ keyExposedAt: '2026-11-26T17:00:00.000Z' });
    expect(connectionNotices(c, 'OWNER')[0]).toMatchObject({
      title: 'Clave en una dirección web',
      text: 'Una plataforma mandó su clave en una dirección web: cámbiala.',
      action: CHANGE_KEY_LABEL,
    });
    expect(suggestedOverlap(c)).toBe('none');
  });

  it('sin nada raro, sin aviso; y una anulada no avisa', () => {
    expect(connectionNotices(conn(), 'OWNER')).toEqual([]);
    expect(connectionNotices(conn({ state: 'revoked', keyExposedAt: '2026-11-26T17:00:00.000Z' }), 'OWNER')).toEqual([]);
    expect(suggestedOverlap(conn())).toBe('24h');
  });

  it('el solape: «Nada», 24 horas o 7 días', () => {
    expect(OVERLAP_CHOICES.map((o) => [o.value, o.label])).toEqual([
      ['none', 'Nada'],
      ['24h', '24 horas'],
      ['7d', '7 días'],
    ]);
  });
});

describe('las IP: solo las que la plataforma declaró a OxioPay (ningún botón añade otras)', () => {
  it('las direcciones sueltas se eligen; los rangos, no (una clave lleva direcciones sueltas)', () => {
    expect(splitPartnerIps(partner.egressIps)).toEqual({
      pickable: ['203.0.113.7', '203.0.113.8', '2001:db8:1:2::/64'],
      ranges: ['198.51.100.0/24', '2001:db8::/48'],
    });
    expect(splitPartnerIps(['203.0.113.9/32', '2001:db8::1/128'])).toEqual({ pickable: ['203.0.113.9/32', '2001:db8::1/128'], ranges: [] });
  });

  it('una IP que no declaró no pasa', () => {
    const r = createPayload(form({ ips: ['192.0.2.1'] }), partner, true, NOW);
    expect(r).toEqual({ ok: false, error: '192.0.2.1 no está entre las que declaró a OxioPay.' });
    expect(createPayload(form({ ips: ['198.51.100.0/24'] }), partner, true, NOW).ok).toBe(false);
  });

  it('como mucho 10', () => {
    const many = { ...partner, egressIps: Array.from({ length: 11 }, (_, i) => `203.0.113.${i + 10}`) };
    const r = createPayload(form({ ips: many.egressIps }), many, true, NOW);
    expect(r).toEqual({ ok: false, error: 'Como mucho 10 IP por conexión.' });
  });
});

describe('la caducidad: de mañana a un año; para cargar saldo, obligatoria', () => {
  it('los límites del calendario y la propuesta (un año)', () => {
    expect(expiryBounds(NOW)).toEqual({ min: '2026-11-27', max: '2027-11-25', suggested: '2027-11-25' });
  });

  it('el día elegido vale hasta las 23:59 de ese día (hora del navegador)', () => {
    expect(expiryToIso('2027-06-30')).toBe(new Date(2027, 5, 30, 23, 59).toISOString());
    expect(expiryToIso('30/06/2027')).toBeNull();
    expect(expiryToIso('2027-02-30')).toBeNull();
  });

  it('obligatoria con permiso de cargar saldo', () => {
    expect(expiryRequired(['wallet:balance'])).toBe(false);
    expect(expiryRequired(['wallet:balance', 'wallet:load'])).toBe(true);
    const msg = 'La caducidad va de mañana a un año; para cargar saldo es obligatoria.';
    expect(createPayload(form({ noExpiry: true }), partner, true, NOW)).toEqual({ ok: false, error: msg });
    expect(createPayload(form({ expiryDay: '2026-11-26' }), partner, true, NOW)).toEqual({ ok: false, error: msg });
    expect(createPayload(form({ expiryDay: '2027-11-27' }), partner, true, NOW)).toEqual({ ok: false, error: msg });
    expect(createPayload(form({ expiryDay: '' }), partner, true, NOW)).toEqual({ ok: false, error: msg });
  });

  it('solo para ver el saldo puede no caducar', () => {
    const r = createPayload(form({ scopes: ['wallet:balance'], noExpiry: true }), partner, true, NOW);
    expect(r).toMatchObject({ ok: true, value: { scopes: ['wallet:balance'], expiresAt: null } });
  });
});

describe('conectar: lo que se manda', () => {
  it('el cuerpo que pide el API (sin el código: lo pone la hoja)', () => {
    expect(createPayload(form(), partner, true, NOW)).toEqual({
      ok: true,
      value: {
        partnerId: partner.id,
        scopes: ['wallet:balance', 'wallet:load'],
        ipAllowlist: ['203.0.113.7'],
        expiresAt: new Date(2027, 5, 30, 23, 59).toISOString(),
        delivery: 'copy',
      },
    });
  });

  it('sin plataforma, sin permisos o con un permiso que no tiene', () => {
    expect(createPayload(form({ partnerId: '' }), partner, true, NOW)).toEqual({ ok: false, error: 'Elige la plataforma.' });
    expect(createPayload(form({ scopes: [] }), partner, true, NOW)).toEqual({ ok: false, error: 'Marca al menos un permiso.' });
    expect(createPayload(form({ scopes: ['wallet:pay'] }), partner, true, NOW)).toEqual({
      ok: false,
      error: 'Esa plataforma no tiene ese permiso.',
    });
  });

  it('el enlace por correo, solo si el servidor manda correos', () => {
    expect(createPayload(form({ delivery: 'email' }), partner, false, NOW)).toEqual({
      ok: false,
      error: 'Este servidor no envía correos: elige «La copio yo».',
    });
    expect(createPayload(form({ delivery: 'email' }), partner, true, NOW)).toMatchObject({ ok: true, value: { delivery: 'email' } });
    expect(deliveryChoices(false, partner.contactEmail).map((d) => d.value)).toEqual(['copy']);
    const both = deliveryChoices(true, partner.contactEmail);
    expect(both.map((d) => d.label)).toEqual(['La copio yo', 'Enviarle un enlace a o***@cajeros.example']);
    expect(deliveryChoices(true, null)[1]!.label).toBe('Enviarle un enlace por correo');
  });
});

describe('cambiar la clave: lo que se manda', () => {
  it('solape, caducidad y entrega', () => {
    expect(rotatePayload({ overlap: 'none', noExpiry: false, expiryDay: '2027-06-30', delivery: 'copy' }, conn(), true, NOW)).toEqual({
      ok: true,
      value: { overlap: 'none', expiresAt: new Date(2027, 5, 30, 23, 59).toISOString(), delivery: 'copy' },
    });
    expect(rotatePayload({ overlap: '24h', noExpiry: true, expiryDay: '', delivery: 'copy' }, conn(), true, NOW).ok).toBe(false);
    expect(
      rotatePayload({ overlap: '24h', noExpiry: true, expiryDay: '', delivery: 'copy' }, conn({ scopes: ['wallet:balance'] }), true, NOW),
    ).toMatchObject({ ok: true, value: { expiresAt: null } });
  });
});

describe('lo que sale al conectar o cambiar la clave', () => {
  const base: Omit<PartnerKeyIssued, 'claim'> = { connection: conn() };

  it('«La copio yo»: la clave, una vez', () => {
    const key = `oxp_live_${'a'.repeat(48)}`;
    expect(issuedOutcome({ ...base, key, claim: { sentTo: null, expiresAt: null, delivered: false } })).toEqual({ kind: 'key', key });
  });

  it('por correo: a quién y hasta cuándo', () => {
    expect(
      issuedOutcome({ ...base, claim: { sentTo: 'o***@cajeros.example', expiresAt: '2026-11-27T17:30:00.000Z', delivered: true } }),
    ).toEqual({ kind: 'sent', sentTo: 'o***@cajeros.example', expiresAt: '2026-11-27T17:30:00.000Z' });
  });

  it('si el correo no salió, la clave no existe en ningún sitio: hay que cambiarla', () => {
    expect(issuedOutcome({ ...base, claim: { sentTo: 'o***@cajeros.example', expiresAt: null, delivered: false } })).toEqual({
      kind: 'failed',
    });
  });
});
