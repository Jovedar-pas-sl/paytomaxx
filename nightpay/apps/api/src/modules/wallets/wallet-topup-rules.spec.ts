import { describe, it, expect } from 'vitest';
import {
  SELF_TOPUP_DAILY_MAX_CENTS,
  SELF_TOPUP_DAILY_MAX_PAID,
  SELF_TOPUP_MAX_UNRESOLVED,
  SELF_TOPUP_MAX_CENTS,
  SELF_TOPUP_MIN_CENTS,
  SELF_TOPUP_PRESETS_CENTS,
  TOPUP_BLOCK_MESSAGES,
  isClientTopUpKey,
  parseTopUpAmount,
  selfTopUpCapProblem,
  selfTopUpClaim,
  selfTopUpClaimHash,
  selfTopUpKey,
  topUpBlock,
  type TopUpVenueState,
  type TopUpWalletState,
} from './wallet-topup-rules';

const wallet = (o: Partial<TopUpWalletState> = {}): TopUpWalletState => ({
  status: 'ACTIVE',
  blockedAt: null,
  mergedIntoId: null,
  closeRequestedAt: null,
  ...o,
});
const venue = (o: Partial<TopUpVenueState> = {}): TopUpVenueState => ({
  paused: false,
  card: true,
  wallet: true,
  hasGateway: true,
  hasTerminal: true,
  ...o,
});

const NOW = new Date('2026-10-20T01:00:00Z');
const later = new Date(NOW.getTime() + 60_000);
const earlier = new Date(NOW.getTime() - 60_000);
const t = (amountCents: number, status: string, qrExpiresAt: Date = later) => ({ amountCents, status, qrExpiresAt });

describe('selfTopUpCapProblem — tope de 24 h por saldo de las recargas desde /w', () => {
  it('600 € y 4 recargas pagadas cada 24 h; 3 a medias o sin confirmar a la vez', () => {
    expect(SELF_TOPUP_DAILY_MAX_CENTS).toBe(60_000);
    expect(SELF_TOPUP_DAILY_MAX_PAID).toBe(4);
    expect(SELF_TOPUP_MAX_UNRESOLVED).toBe(3);
  });

  it('importe: lo pagado (también lo devuelto) + lo que aún puede cobrarse + esta', () => {
    expect(selfTopUpCapProblem([], 30_000, NOW)).toBeNull();
    expect(selfTopUpCapProblem([t(30_000, 'AUTHORIZED')], 30_000, NOW)).toBeNull();
    expect(selfTopUpCapProblem([t(30_000, 'AUTHORIZED')], 30_100, NOW)).toBe('daily-amount');
    expect(selfTopUpCapProblem([t(30_000, 'REFUNDED'), t(25_000, 'AUTHORIZING')], 10_000, NOW)).toBe('daily-amount');
    expect(selfTopUpCapProblem([t(30_000, 'PARTIALLY_REFUNDED'), t(25_000, 'CREATED')], 5_000, NOW)).toBeNull();
  });

  it('lo caducado, fallido o cancelado no cuenta', () => {
    const dead = [t(30_000, 'EXPIRED'), t(30_000, 'FAILED'), t(30_000, 'CANCELED'), t(30_000, 'CREATED', earlier)];
    expect(selfTopUpCapProblem(dead, 30_000, NOW)).toBeNull();
  });

  it('nº de pagadas y de a medias', () => {
    expect(selfTopUpCapProblem(Array.from({ length: 4 }, () => t(1_000, 'AUTHORIZED')), 1_000, NOW)).toBe('daily-count');
    expect(selfTopUpCapProblem([t(1_000, 'AUTHORIZING'), t(1_000, 'ORPHAN'), t(1_000, 'CREATED')], 1_000, NOW)).toBe('unresolved');
    expect(selfTopUpCapProblem([t(1_000, 'AUTHORIZING'), t(1_000, 'ORPHAN'), t(1_000, 'CREATED', earlier)], 1_000, NOW)).toBeNull();
  });
});

describe('«Recargar» desde /w: importes', () => {
  it('las sugeridas (20, 50, 100 €) están dentro de los límites (10 € a 300 €)', () => {
    expect(SELF_TOPUP_PRESETS_CENTS).toEqual([2000, 5000, 10000]);
    for (const c of SELF_TOPUP_PRESETS_CENTS) expect(parseTopUpAmount(c)).toBe(c);
    expect(SELF_TOPUP_MIN_CENTS).toBe(1000);
    expect(SELF_TOPUP_MAX_CENTS).toBe(30000);
  });

  it('los límites valen, incluidos', () => {
    expect(parseTopUpAmount(1000)).toBe(1000);
    expect(parseTopUpAmount(30000)).toBe(30000);
    expect(parseTopUpAmount(7700)).toBe(7700);
  });

  it('fuera de los límites, con céntimos o que no es un número entero → no vale', () => {
    for (const bad of [900, 0, -2000, 30100, 1_000_000, 1050, 2000.5, '2000', null, undefined, NaN, Infinity, {}]) {
      expect(parseTopUpAmount(bad)).toBeNull();
    }
  });

  it('clave del navegador: 16-64 letras, números, - o _', () => {
    expect(isClientTopUpKey('a'.repeat(16))).toBe(true);
    expect(isClientTopUpKey('Ab3_-Ab3_-Ab3_-Ab3_-22')).toBe(true);
    for (const bad of ['corta', 'a'.repeat(65), 'con espacios aaaaaaa', 'dos:puntos-aaaaaaaa', 42, null]) {
      expect(isClientTopUpKey(bad)).toBe(false);
    }
  });
});

describe('«Recargar» desde /w: cuándo se puede', () => {
  it('saldo activo, o a cero (es cuando más se recarga), en un local que cobra → sí', () => {
    expect(topUpBlock(wallet(), venue())).toBeNull();
    expect(topUpBlock(wallet({ status: 'DEPLETED' }), venue())).toBeNull();
  });

  it('lo del saldo: bloqueado, sumado a otro, cerrado o con «Me voy» pedido → no', () => {
    expect(topUpBlock(wallet({ blockedAt: new Date() }), venue())).toBe('blocked');
    expect(topUpBlock(wallet({ status: 'DEPLETED', mergedIntoId: 'w-2' }), venue())).toBe('merged');
    expect(topUpBlock(wallet({ status: 'REFUNDED' }), venue())).toBe('closed');
    expect(topUpBlock(wallet({ status: 'EXPIRED' }), venue())).toBe('closed');
    expect(topUpBlock(wallet({ closeRequestedAt: new Date() }), venue())).toBe('leaving');
  });

  it('lo del local: en pausa, «Formas de cobro» apagadas, sin pasarela o sin datáfono → no', () => {
    expect(topUpBlock(wallet(), venue({ paused: true }))).toBe('paused');
    expect(topUpBlock(wallet(), venue({ card: false }))).toBe('method-off');
    expect(topUpBlock(wallet(), venue({ wallet: false }))).toBe('method-off');
    expect(topUpBlock(wallet(), venue({ hasGateway: false }))).toBe('no-gateway');
    expect(topUpBlock(wallet(), venue({ hasTerminal: false }))).toBe('no-terminal');
  });

  it('primero lo del saldo (lo que el cliente entiende) y el bloqueo antes que nada', () => {
    expect(topUpBlock(wallet({ blockedAt: new Date(), status: 'REFUNDED' }), venue({ paused: true }))).toBe('blocked');
    expect(topUpBlock(wallet({ closeRequestedAt: new Date() }), venue({ paused: true }))).toBe('leaving');
    expect(topUpBlock(wallet(), venue({ paused: true, card: false }))).toBe('paused');
  });

  it('cada motivo tiene su mensaje', () => {
    for (const msg of Object.values(TOPUP_BLOCK_MESSAGES)) expect(msg.length).toBeGreaterThan(10);
  });
});

describe('«Recargar» desde /w: vuelta al saldo tras pagar', () => {
  const SECRET = 'secreto-de-las-pruebas-0123456789abcdef';

  it('la cookie de vuelta sale de la clave del navegador: la misma petición, la misma cookie', () => {
    const a = selfTopUpClaim(SECRET, 'w-1', 'k'.repeat(22));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(selfTopUpClaim(SECRET, 'w-1', 'k'.repeat(22))).toBe(a);
    // Otro saldo, otra clave u otro secreto → otra.
    expect(selfTopUpClaim(SECRET, 'w-2', 'k'.repeat(22))).not.toBe(a);
    expect(selfTopUpClaim(SECRET, 'w-1', 'j'.repeat(22))).not.toBe(a);
    expect(selfTopUpClaim(`${SECRET}x`, 'w-1', 'k'.repeat(22))).not.toBe(a);
  });

  it('la Idempotency-Key lleva la huella de la cookie y se lee de vuelta', () => {
    const claim = selfTopUpClaim(SECRET, 'w-1', 'k'.repeat(22));
    const key = selfTopUpKey(claim);
    expect(key).toMatch(/^wtopup:[0-9a-f]{64}$/);
    expect(key).not.toContain(claim);
    expect(selfTopUpClaimHash(key)).toBe(key.slice('wtopup:'.length));
  });

  it('el personal no puede crear una: su cabecera no admite «:» (y las claves normales no cuentan)', () => {
    const header = /^[A-Za-z0-9_-]{8,}$/; // la de IdempotencyKey
    expect(header.test(selfTopUpKey('x'.repeat(43)))).toBe(false);
    for (const k of ['op-1234-abcd', 'wtopup-' + 'a'.repeat(64), `wtopup:${'z'.repeat(64)}`, 'wtopup:', null, undefined]) {
      expect(selfTopUpClaimHash(k)).toBeNull();
    }
  });
});
