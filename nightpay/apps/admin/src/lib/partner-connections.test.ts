import { describe, expect, it } from 'vitest';
import {
  stepUpActions,
  type PartnerConnectionView,
  type PartnerKeyIssued,
  type PartnerLoadAdminView,
  type PartnerOptionView,
  type PartnerOwnerStatement,
} from '@nightpay/contracts';
import {
  ACTION_LABELS,
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
  LIMITS_START_TEXT,
  NIGHT_WINDOW_TEXT,
  canVoidLoad,
  deviceLabel,
  issuedOutcome,
  limitsFormOf,
  limitsPayload,
  limitsStepUpAction,
  loadState,
  nightNav,
  rotatePayload,
  statementTotals,
  voidLoadWarning,
  voidReasonProblem,
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
  // «Movimientos» (dueño y encargado, también en una anulada: el recuento de
  // la mañana) y «Topes» (solo el dueño, no en una anulada) van delante.
  const base = (actions: string[]) => actions.filter((a) => a !== 'movements' && a !== 'limits');

  it('el dueño: cambiar la clave, pausar y anular; reanudar si está en pausa o dormida', () => {
    expect(base(connectionActions(conn(), 'OWNER'))).toEqual(['rotate', 'pause', 'revoke']);
    expect(base(connectionActions(conn({ state: 'paused', pausedBy: 'manager' }), 'OWNER'))).toEqual(['resume', 'rotate', 'revoke']);
    expect(base(connectionActions(conn({ pausedBy: 'foreign_ip', pausedScopes: ['wallet:load'] }), 'OWNER'))).toEqual([
      'resume',
      'rotate',
      'revoke',
    ]);
    expect(base(connectionActions(conn({ state: 'dormant' }), 'OWNER'))).toEqual(['resume', 'rotate', 'revoke']);
    expect(base(connectionActions(conn({ state: 'expired' }), 'OWNER'))).toEqual(['rotate', 'revoke']);
  });

  it('la pausa de OxioPay no la quita el dueño (solo la consola)', () => {
    expect(connectionActions(conn({ state: 'paused', pausedBy: 'oxiopay' }), 'OWNER')).not.toContain('resume');
    expect(connectionActions(conn({ state: 'dormant', pausedBy: 'oxiopay' }), 'OWNER')).not.toContain('resume');
  });

  it('el encargado solo pausa y anula', () => {
    expect(base(connectionActions(conn(), 'MANAGER'))).toEqual(['pause', 'revoke']);
    expect(base(connectionActions(conn({ state: 'paused', pausedBy: 'owner' }), 'MANAGER'))).toEqual(['revoke']);
    expect(base(connectionActions(conn({ state: 'dormant' }), 'MANAGER'))).toEqual(['revoke']);
  });

  it('anulada: solo «Movimientos» (cambiado a propósito en la PR 3 B: antes, nada)', () => {
    expect(connectionActions(conn({ state: 'revoked' }), 'OWNER')).toEqual(['movements']);
    expect(connectionActions(conn({ state: 'revoked' }), 'MANAGER')).toEqual(['movements']);
  });

  it('«Movimientos», al dueño y al encargado, en todos los estados', () => {
    for (const state of ['active', 'paused', 'dormant', 'expired', 'revoked'] as const) {
      for (const role of ['OWNER', 'MANAGER']) expect(connectionActions(conn({ state }), role)[0]).toBe('movements');
    }
  });

  it('«Topes»: solo el dueño y no en una anulada', () => {
    expect(connectionActions(conn(), 'OWNER')).toEqual(['movements', 'limits', 'rotate', 'pause', 'revoke']);
    expect(connectionActions(conn({ state: 'paused', pausedBy: 'oxiopay' }), 'OWNER')).toEqual(['movements', 'limits', 'rotate', 'revoke']);
    expect(connectionActions(conn({ state: 'expired' }), 'OWNER')).toContain('limits');
    expect(connectionActions(conn({ state: 'revoked' }), 'OWNER')).not.toContain('limits');
    for (const state of ['active', 'paused', 'dormant', 'expired', 'revoked'] as const) {
      expect(connectionActions(conn({ state }), 'MANAGER')).not.toContain('limits');
    }
  });

  it('los botones nuevos se llaman «Movimientos» y «Topes»', () => {
    expect(ACTION_LABELS.movements).toBe('Movimientos');
    expect(ACTION_LABELS.limits).toBe('Topes');
  });
});

describe('las cargas en pausa (load_refusals, load_burst, load_voids)', () => {
  const texts = {
    load_refusals: 'En pausa: 3 cargas por encima del máximo por recarga en 10 minutos.',
    load_burst: 'En pausa: más de 30 cargas en un minuto.',
    load_voids: 'En pausa: 3 cargas anuladas por la plataforma esta noche.',
  } as const;

  for (const [pausedBy, text] of Object.entries(texts) as Array<[keyof typeof texts, string]>) {
    it(`${pausedBy}: «Cargas en pausa», con su texto`, () => {
      const c = conn({ pausedBy, pausedScopes: ['wallet:load'] });
      for (const role of ['OWNER', 'MANAGER']) {
        expect(connectionNotices(c, role)).toEqual([{ tone: 'warning', title: 'Cargas en pausa', text, action: null }]);
      }
      // La quita el dueño con «Reanudar» (ya pide la 2FA).
      expect(connectionActions(c, 'OWNER')).toContain('resume');
      expect(connectionActions(c, 'MANAGER')).not.toContain('resume');
    });
  }

  it('otras pausas no lo dicen; una anulada tampoco', () => {
    for (const pausedBy of ['owner', 'manager', 'foreign_ip', 'oxiopay'] as const) {
      expect(connectionNotices(conn({ state: 'paused', pausedBy }), 'OWNER').some((n) => n.title === 'Cargas en pausa')).toBe(false);
    }
    expect(connectionNotices(conn({ state: 'revoked', pausedBy: 'load_burst' }), 'OWNER')).toEqual([]);
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

// ─── «Movimientos», «Anular carga» y «Topes» (PR 3 B) ────────────────────

const sp = (s: string) => s.replace(/\u00a0/g, ' ');

function load(over: Partial<PartnerLoadAdminView> = {}): PartnerLoadAdminView {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    publicId: 'wl_33333333333343338333333333333333',
    status: 'succeeded',
    amountCents: 3000,
    description: 'Carga en cajero',
    reference: null,
    funding: 'cash',
    device: 'ATM-1',
    createdAt: '2026-11-26T23:00:00.000Z',
    // Los 10 minutos del socio por la API: el panel anula hasta 36 h.
    voidUntil: '2026-11-26T23:10:00.000Z',
    voidedAt: null,
    voidedBy: null,
    reason: null,
    balanceAfterCents: 3000,
    codeHint: 'K7Q-•••',
    ...over,
  };
}

describe('«Movimientos»: la noche', () => {
  it('va de 08:00 a 08:00', () => {
    expect(NIGHT_WINDOW_TEXT).toBe('La noche va de 08:00 a 08:00.');
  });

  it('la anterior y la siguiente; nunca después de hoy', () => {
    expect(nightNav('2026-11-26', '2026-11-26')).toEqual({ previous: '2026-11-25', next: null });
    expect(nightNav('2026-11-24', '2026-11-26')).toEqual({ previous: '2026-11-23', next: '2026-11-25' });
    expect(nightNav('2026-12-01', '2026-11-26')).toEqual({ previous: '2026-11-30', next: null });
    expect(nightNav('2026-03-01', '2026-11-26').previous).toBe('2026-02-28');
  });
});

describe('«Movimientos»: los totales y por cajero', () => {
  const st: PartnerOwnerStatement = {
    object: 'statement',
    from: '2026-11-26T07:00:00Z',
    to: '2026-11-27T07:00:00Z',
    currency: 'eur',
    livemode: true,
    loads: {
      count: 4,
      amount: 12000,
      by_funding: {
        cash: { count: 4, amount: 12000 },
        card: { count: 0, amount: 0 },
        transfer: { count: 0, amount: 0 },
        bank_app: { count: 0, amount: 0 },
      },
    },
    load_voids: { count: 1, amount: 3000 },
    net_loads: 9000,
    byDevice: [],
  } as unknown as PartnerOwnerStatement;

  it('«Cargas», «Anuladas» y «Neto»', () => {
    expect(statementTotals(st)).toEqual([
      { key: 'loads', label: 'Cargas', count: 4, cents: 12000 },
      { key: 'voids', label: 'Anuladas', count: 1, cents: 3000 },
      { key: 'net', label: 'Neto', count: null, cents: 9000 },
    ]);
  });

  it('las cargas sin cajero: «Sin cajero»', () => {
    expect(deviceLabel(null)).toBe('Sin cajero');
    expect(deviceLabel('ATM-1')).toBe('ATM-1');
    expect(deviceLabel('  ')).toBe('Sin cajero');
  });
});

describe('«Movimientos»: cada carga', () => {
  const NOW_MS = Date.parse('2026-11-27T10:00:00.000Z');

  it('anulada por la plataforma o en el panel, con su motivo', () => {
    expect(loadState(load())).toBeNull();
    expect(loadState(load({ status: 'voided', voidedAt: '2026-11-27T00:00:00Z', voidedBy: 'partner', reason: 'duplicada' }))).toEqual({
      label: 'Anulada por la plataforma',
      reason: 'duplicada',
    });
    expect(loadState(load({ status: 'voided', voidedAt: '2026-11-27T00:00:00Z', voidedBy: 'venue', reason: 'no pagó' }))).toEqual({
      label: 'Anulada en el panel',
      reason: 'no pagó',
    });
    expect(loadState(load({ status: 'voided', voidedAt: '2026-11-27T00:00:00Z', voidedBy: 'venue', reason: null }))).toEqual({
      label: 'Anulada en el panel',
      reason: null,
    });
  });

  it('«Anular carga»: solo si no está anulada y tiene menos de 36 h (manda el servidor)', () => {
    expect(canVoidLoad(load(), NOW_MS)).toBe(true);
    // Pasados los 10 minutos del socio, el panel aún puede (hasta 36 h desde la carga).
    expect(canVoidLoad(load({ voidUntil: '2026-11-26T23:10:00.000Z' }), NOW_MS)).toBe(true);
    const created = Date.parse('2026-11-26T23:00:00.000Z');
    expect(canVoidLoad(load(), created + 36 * 3_600_000 - 1)).toBe(true);
    expect(canVoidLoad(load(), created + 36 * 3_600_000)).toBe(false);
    expect(canVoidLoad(load({ status: 'voided', voidedAt: '2026-11-27T00:00:00Z', voidedBy: 'partner' }), NOW_MS)).toBe(false);
  });

  it('el motivo: de 3 a 140 letras', () => {
    expect(voidReasonProblem('')).toBe('Explica por qué se anula');
    expect(voidReasonProblem('  ab  ')).toBe('Explica por qué se anula');
    expect(voidReasonProblem('abc')).toBeNull();
    expect(voidReasonProblem('x'.repeat(140))).toBeNull();
    expect(voidReasonProblem('x'.repeat(141))).toBe('Explica por qué se anula');
  });

  it('lo que pasa al anularla', () => {
    expect(sp(voidLoadWarning(3000))).toBe(
      'El saldo del cliente baja 30,00 € y le llega el aviso «Carga anulada». Hazlo solo si el dinero no se quedó en el local.',
    );
  });
});

describe('«Topes»: los tres máximos en euros', () => {
  const current = { perOperationCents: 30000, walletDayCents: 60000, nightCents: 500000 };

  it('el consejo para empezar', () => {
    expect(LIMITS_START_TEXT).toBe('Si los cajeros se vacían menos de una vez al día, empieza con 2.000 € por noche.');
  });

  it('el formulario sale con los de ahora', () => {
    expect(limitsFormOf(current)).toEqual({ perOperation: '300', walletDay: '600', night: '5000' });
    expect(limitsFormOf({ perOperationCents: 1050, walletDayCents: 60000, nightCents: 200000 }).perOperation).toBe('10,50');
  });

  it('bajar no pide la 2FA; subir cualquiera, sí', () => {
    expect(limitsPayload({ perOperation: '300', walletDay: '600', night: '2.000' }, current)).toEqual({
      ok: true,
      value: { body: { perOperationCents: 30000, walletDayCents: 60000, nightCents: 200000 }, raises: false },
    });
    expect(limitsPayload({ perOperation: '300,01', walletDay: '600', night: '2000' }, current)).toMatchObject({
      ok: true,
      value: { raises: true },
    });
    expect(limitsPayload({ perOperation: '300', walletDay: '600', night: '6000' }, current)).toMatchObject({ ok: true, value: { raises: true } });
  });

  it('con los máximos de LOAD_CAPS', () => {
    expect(limitsPayload({ perOperation: '999,99', walletDay: '999,99', night: '50.000' }, current).ok).toBe(true);
    const over = limitsPayload({ perOperation: '1000', walletDay: '600', night: '2000' }, current);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(sp(over.error)).toBe('El máximo por recarga va de 0,01 € a 999,99 €.');
    const night = limitsPayload({ perOperation: '300', walletDay: '600', night: '50.000,01' }, current);
    if (!night.ok) expect(sp(night.error)).toBe('El máximo por noche va de 0,01 € a 50.000,00 €.');
    expect(night.ok).toBe(false);
    expect(limitsPayload({ perOperation: '300', walletDay: '', night: '2000' }, current).ok).toBe(false);
    expect(limitsPayload({ perOperation: '300', walletDay: '0', night: '2000' }, current).ok).toBe(false);
  });

  it('sin cambiar nada, no se manda', () => {
    expect(limitsPayload(limitsFormOf(current), current)).toEqual({ ok: false, error: 'No has cambiado ningún tope.' });
  });

  it('la acción de la llave: partner:limits:<conexión>:<op>-<día>-<noche>, en céntimos (como la comprueba el API)', () => {
    const body = { perOperationCents: 40000, walletDayCents: 60000, nightCents: 200000 };
    expect(limitsStepUpAction(conn().id, body)).toBe(stepUpActions.partner('limits', conn().id, '40000-60000-200000'));
    expect(limitsStepUpAction(conn().id, body)).toBe(`partner:limits:${conn().id}:40000-60000-200000`);
  });
});
