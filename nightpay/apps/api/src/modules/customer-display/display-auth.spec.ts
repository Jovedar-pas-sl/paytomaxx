import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { CUSTOMER_DISPLAY_CODE_ALPHABET } from '@nightpay/contracts';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { bearerToken, verifyStaffToken } from '../../common/guards/staff-token';
import { IP_RATE_LIMIT_META } from '../../common/guards/ip-rate-limit.guard';
import { CustomerDisplayController } from './customer-display.controller';
import { cleanToken, displayRoom, displayTokenFromHeader, findActiveDisplay, followedRooms, pairingExpiresAt } from './display-auth';
import { formatDisplayCode, newDisplayCode, newDisplayToken, normalizeDisplayCode, sha256 } from './display-code';
import { DisplayGuard } from './display.guard';

const NOW = new Date('2026-11-17T23:00:00Z');
const TOKEN = newDisplayToken();

function prismaWith(row: unknown, closedNight: unknown = null) {
  const findUnique = vi.fn(() => Promise.resolve(row));
  const findNight = vi.fn(() => Promise.resolve(closedNight));
  const tx = { customerDisplay: { findUnique }, venueNight: { findFirst: findNight } };
  return { prisma: { asSystem: vi.fn((fn: (t: unknown) => unknown) => fn(tx)) }, findUnique, findNight };
}

const ACTIVE = {
  id: 'd1',
  tenantId: 't1',
  userId: 'u1',
  pairedAt: new Date(NOW.getTime() - 3600_000),
  tipCents: 0,
  expiresAt: new Date(NOW.getTime() + 3600_000),
  revokedAt: null,
  paymentId: 'P1',
  chargeId: null,
  clearedAt: null,
  lastSeenAt: null,
  user: { deletedAt: null, role: 'WAITER' },
};

describe('pantalla del cliente: código y credencial', () => {
  it('código de 6 letras sin las que se confunden, que se teclea como sea', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newDisplayCode();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(CUSTOMER_DISPLAY_CODE_ALPHABET).toContain(ch);
      expect(normalizeDisplayCode(formatDisplayCode(code).toLowerCase())).toBe(code);
    }
    expect(formatDisplayCode('K7P4QX')).toBe('K7P-4QX');
  });

  it('credencial larga y al azar; solo se guarda su huella', () => {
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDisplayToken()).not.toBe(TOKEN);
    expect(sha256(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('solo `Authorization: Pantalla …`: un Bearer, vacío o con forma rara no vale', () => {
    expect(displayTokenFromHeader(`Pantalla ${TOKEN}`)).toBe(TOKEN);
    expect(displayTokenFromHeader(`Bearer ${TOKEN}`)).toBeNull();
    expect(displayTokenFromHeader('Pantalla ')).toBeNull();
    expect(displayTokenFromHeader('Pantalla a b c')).toBeNull();
    expect(displayTokenFromHeader(undefined)).toBeNull();
    expect(cleanToken(42)).toBeNull();
  });

  it('la credencial de la tablet no abre nada del personal: no es un Bearer ni un JWT', async () => {
    expect(bearerToken(`Pantalla ${TOKEN}`)).toBeNull();
    const jwt = { verifyAsync: vi.fn(() => Promise.reject(new Error('jwt malformed'))) };
    expect(await verifyStaffToken(jwt as never, TOKEN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('salas: la de la pantalla y las de su cobro', () => {
    expect(displayRoom('ABC')).toBe('display:abc');
    expect(followedRooms({ paymentId: 'P1', chargeId: 'C1' })).toEqual(['payment:p1', 'wallet-charge:c1']);
    expect(followedRooms({ paymentId: null, chargeId: null })).toEqual([]);
  });
});

describe('pantalla del cliente: ¿vale la credencial?', () => {
  it('emparejada y en plazo: su local, su persona y su cobro (por la huella, nunca la credencial)', async () => {
    const { prisma, findUnique } = prismaWith(ACTIVE);
    const display = await findActiveDisplay(prisma as never, TOKEN, NOW);
    expect(display).toMatchObject({ id: 'd1', tenantId: 't1', userId: 'u1', paymentId: 'P1', tokenHash: sha256(TOKEN) });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: sha256(TOKEN) } }));
  });

  it('desemparejada, caducada (12 h), sin fila o con su persona de baja: no', async () => {
    const cases = [
      null,
      { ...ACTIVE, revokedAt: NOW },
      { ...ACTIVE, expiresAt: NOW },
      { ...ACTIVE, expiresAt: null },
      { ...ACTIVE, user: { deletedAt: NOW } },
    ];
    for (const row of cases) expect(await findActiveDisplay(prismaWith(row).prisma as never, TOKEN, NOW)).toBeNull();
  });

  it('la noche se cerró después de emparejar: ya no vale (aunque no hayan pasado 12 h)', async () => {
    const { prisma, findNight } = prismaWith(ACTIVE, { id: 'n1' });
    expect(await findActiveDisplay(prisma as never, TOKEN, NOW)).toBeNull();
    expect(findNight).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't1', closedAt: { gt: ACTIVE.pairedAt } } }));
  });

  it('caduca en el corte de la noche (08:00 de Madrid) y nunca después de 12 h', () => {
    // 23:00 de Madrid (UTC+1 en noviembre): a las 08:00 del día siguiente (9 h).
    expect(pairingExpiresAt(new Date('2026-11-17T22:00:00Z')).toISOString()).toBe('2026-11-18T07:00:00.000Z');
    // 18:00 de Madrid: a las 12 h (06:00), antes del corte.
    expect(pairingExpiresAt(new Date('2026-11-17T17:00:00Z')).toISOString()).toBe('2026-11-18T05:00:00.000Z');
    // 07:30 de Madrid: en el corte, a la media hora.
    expect(pairingExpiresAt(new Date('2026-11-18T06:30:00Z')).toISOString()).toBe('2026-11-18T07:00:00.000Z');
  });
});

describe('pantalla del cliente: rutas', () => {
  const reflector = new Reflector();
  const proto = CustomerDisplayController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const guards = (name: string) => (Reflect.getMetadata('__guards__', proto[name]) ?? []) as unknown[];
  const isPublic = (name: string) => reflector.get<boolean>(IS_PUBLIC_KEY, proto[name]) === true;

  it('emparejar es público con tope de intentos por IP (10 cada 5 min)', () => {
    expect(isPublic('pair')).toBe(true);
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.pair)).toMatchObject({ max: 10, windowSec: 300 });
  });

  it('la tablet solo lee su pantalla y se desempareja (con su guarda); nada más es público', () => {
    for (const name of ['screen', 'unpairDisplay', 'setTip', 'payWithFicha', 'payWithFichaPin']) {
      expect(isPublic(name)).toBe(true);
      expect(guards(name)).toContain(DisplayGuard);
    }
    for (const name of ['status', 'createCode', 'unpair', 'show', 'clear', 'message', 'setMessage']) {
      expect(isPublic(name), name).toBe(false);
      expect(guards(name)).not.toContain(DisplayGuard);
    }
  });

  it('el mensaje del reposo: solo el dueño y el encargado lo leen y lo cambian (la tablet lo recibe en su pantalla)', () => {
    for (const name of ['message', 'setMessage']) {
      expect(guards(name), name).toContain(RolesGuard);
      expect(reflector.get<string[]>(ROLES_KEY, proto[name]), name).toEqual(['OWNER', 'MANAGER']);
    }
  });

  it('pagar con ficha desde la tablet: el mismo tope por IP que el PIN del móvil del personal', () => {
    for (const name of ['payWithFicha', 'payWithFichaPin']) {
      expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto[name])).toMatchObject({ max: 30, windowSec: 60, scope: 'wallet-pin' });
    }
  });
});
