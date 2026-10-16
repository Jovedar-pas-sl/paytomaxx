import { describe, it, expect, vi } from 'vitest';
import {
  VENUE_PAUSED_CODE,
  VenuePausedException,
  assertVenueAcceptsCharges,
  assertVenueNotPaused,
  venuePauseScope,
} from './venue-pause';

const PAUSED_AT = new Date('2026-10-16T22:00:00Z');

describe('venuePauseScope — local o negocio en pausa', () => {
  it('activo (sin pausa y negocio activo o sin negocio) → null', () => {
    expect(venuePauseScope({ pausedAt: null, business: null })).toBeNull();
    expect(venuePauseScope({ pausedAt: null, business: { status: 'ACTIVE' } })).toBeNull();
    expect(venuePauseScope({ pausedAt: null })).toBeNull();
    expect(venuePauseScope(null)).toBeNull();
  });

  it('local en pausa → venue (aunque el negocio también lo esté)', () => {
    expect(venuePauseScope({ pausedAt: PAUSED_AT, business: { status: 'ACTIVE' } })).toBe('venue');
    expect(venuePauseScope({ pausedAt: PAUSED_AT, business: { status: 'PAUSED' } })).toBe('venue');
  });

  it('negocio en pausa → business', () => {
    expect(venuePauseScope({ pausedAt: null, business: { status: 'PAUSED' } })).toBe('business');
  });
});

describe('assertVenueNotPaused — 423 VENUE_PAUSED en español', () => {
  it('en pausa: 423 con code VENUE_PAUSED, qué lo pausa y el texto para la app', () => {
    try {
      assertVenueNotPaused({ pausedAt: null, business: { status: 'PAUSED' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VenuePausedException);
      const e = err as VenuePausedException;
      expect(e.getStatus()).toBe(423);
      expect(e.getResponse()).toMatchObject({ code: VENUE_PAUSED_CODE, pausedBy: 'business' });
      expect((e.getResponse() as { message: string }).message).toMatch(/negocio de este local está en pausa/);
      expect((e.getResponse() as { message: string }).message).toMatch(/devoluciones/);
    }
  });

  it('activo: no lanza', () => {
    expect(() => assertVenueNotPaused({ pausedAt: null, business: { status: 'ACTIVE' } })).not.toThrow();
  });

  it('assertVenueAcceptsCharges lee pausa del local y estado del negocio', async () => {
    const findUnique = vi.fn().mockResolvedValue({ pausedAt: PAUSED_AT, business: null });
    await expect(assertVenueAcceptsCharges({ venue: { findUnique } } as never, 'v-1')).rejects.toBeInstanceOf(VenuePausedException);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      select: { pausedAt: true, business: { select: { status: true } } },
    });
    findUnique.mockResolvedValue({ pausedAt: null, business: { status: 'ACTIVE' } });
    await expect(assertVenueAcceptsCharges({ venue: { findUnique } } as never, 'v-1')).resolves.toBeUndefined();
  });
});
