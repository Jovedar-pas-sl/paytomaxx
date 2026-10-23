import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_NIGHT_SETTINGS,
  UpdateNightSettingsSchema,
  mergeNightSettings,
  nightSettingsOf,
  nightSettingsProblem,
  type JwtPayload,
} from '@nightpay/contracts';
import { VenueSettingsController } from './venue-settings.controller';
import { VenuesController } from './venues.controller';

/** Ajustes de la noche (Ajustes → Noche): lo de fábrica funciona sin tocar nada. */

describe('ajustes de la noche: lo guardado con lo de fábrica donde falte', () => {
  it('de fábrica: 20 € sin PIN, 100 € por noche, teclado fijo, 20 · 50 · 100 en efectivo, vibración y sonido, 300 € de salidas por recepcionista', () => {
    expect(nightSettingsOf(null)).toEqual({
      nfcNoPinMaxCents: 2_000,
      nfcNoPinNightCapCents: 10_000,
      pinKeypad: 'fixed',
      receptionQuickAmountsCents: [2_000, 5_000, 10_000],
      receptionDefaultMethod: 'cash',
      feedbackVibration: true,
      feedbackSound: true,
      receptionPayoutNightCapCents: 30_000,
      highContrast: false,
    });
    expect(nightSettingsOf('basura')).toEqual(DEFAULT_NIGHT_SETTINGS);
  });

  it('modo «sala» (contraste alto, decisión D9): apagado de fábrica, se enciende y un valor raro no lo enciende', () => {
    expect(DEFAULT_NIGHT_SETTINGS.highContrast).toBe(false);
    expect(nightSettingsOf({ highContrast: true }).highContrast).toBe(true);
    expect(nightSettingsOf({ highContrast: 'sí' }).highContrast).toBe(false);
    expect(mergeNightSettings({ highContrast: true }, { feedbackSound: false })).toMatchObject({ highContrast: true, feedbackSound: false });
    expect(mergeNightSettings({ highContrast: true }, { highContrast: false }).highContrast).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ highContrast: true }).success).toBe(true);
    expect(UpdateNightSettingsSchema.safeParse({ highContrast: 'sí' }).success).toBe(false);
  });

  it('un valor raro no rompe nada: vuelve a lo de fábrica (y los importes se ordenan sin repetir)', () => {
    const s = nightSettingsOf({
      nfcNoPinMaxCents: -5,
      nfcNoPinNightCapCents: 1.5,
      pinKeypad: 'aleatorio',
      receptionQuickAmountsCents: [10_000, 'x', 2_000, 2_000, 50],
      receptionDefaultMethod: 'bizum',
      feedbackSound: 'no',
    });
    expect(s).toEqual({ ...DEFAULT_NIGHT_SETTINGS, receptionQuickAmountsCents: [2_000, 10_000] });
    expect(nightSettingsOf({ receptionQuickAmountsCents: [] }).receptionQuickAmountsCents).toEqual([2_000, 5_000, 10_000]);
  });

  it('el cambio se mezcla con lo guardado', () => {
    const merged = mergeNightSettings({ pinKeypad: 'shuffled' }, { nfcNoPinMaxCents: 1_000, feedbackSound: false });
    expect(merged).toMatchObject({ pinKeypad: 'shuffled', nfcNoPinMaxCents: 1_000, nfcNoPinNightCapCents: 10_000, feedbackSound: false });
  });

  it('validación: nada que cambiar, más de 50 € sin PIN, importes raros o un campo desconocido → no vale', () => {
    expect(UpdateNightSettingsSchema.safeParse({}).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ nfcNoPinMaxCents: 5_001 }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ nfcNoPinNightCapCents: 50_001 }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ receptionQuickAmountsCents: [] }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ receptionQuickAmountsCents: [1, 2, 3, 4, 5].map((n) => n * 1_000) }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ receptionQuickAmountsCents: [100_000] }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ pinKeypad: 'random' }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ iva: 21 }).success).toBe(false);
    expect(UpdateNightSettingsSchema.safeParse({ nfcNoPinMaxCents: 0 }).success).toBe(true);
    expect(UpdateNightSettingsSchema.safeParse({ receptionDefaultMethod: 'card' }).success).toBe(true);
  });

  it('el tope de la noche no baja del máximo por cobro (salvo con el NFC sin PIN apagado)', () => {
    expect(nightSettingsProblem({ ...DEFAULT_NIGHT_SETTINGS, nfcNoPinNightCapCents: 1_500 })).toMatch(/tope/);
    expect(nightSettingsProblem({ ...DEFAULT_NIGHT_SETTINGS, nfcNoPinMaxCents: 0, nfcNoPinNightCapCents: 0 })).toBeNull();
    expect(nightSettingsProblem(DEFAULT_NIGHT_SETTINGS)).toBeNull();
  });
});

describe('VenueSettingsController: la noche', () => {
  const owner = { sub: 'own-1', email: 'dueno@local.es', role: 'OWNER', tenantId: 't-1' } as JwtPayload;

  function make(stored: Record<string, unknown> = {}) {
    const venue = { paymentMethods: null, staffPermissions: null, alertSettings: null, nightSettings: null, ...stored };
    const tx = {
      venue: {
        findUniqueOrThrow: vi.fn(async () => venue),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(venue, data)),
      },
    };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const ctrl = new VenueSettingsController(prisma as never, audit as never, { get: () => undefined } as never);
    return { ctrl, tx, audit };
  }

  it('el personal los lee completos; el dueño los cambia y queda en el registro lo de antes y lo de después', async () => {
    const { ctrl, tx, audit } = make();
    await expect(ctrl.night(owner)).resolves.toEqual(DEFAULT_NIGHT_SETTINGS);
    const res = await ctrl.updateNight(owner, { pinKeypad: 'shuffled', receptionQuickAmountsCents: [5_000, 2_000] });
    expect(res).toMatchObject({ pinKeypad: 'shuffled', receptionQuickAmountsCents: [2_000, 5_000] });
    expect(tx.venue.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't-1' }, data: { nightSettings: expect.objectContaining({ pinKeypad: 'shuffled' }) } }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'venue.night_settings.updated',
        payload: { before: expect.objectContaining({ pinKeypad: 'fixed' }), after: expect.objectContaining({ pinKeypad: 'shuffled' }) },
      }),
    );
    await expect(ctrl.night(owner)).resolves.toMatchObject({ pinKeypad: 'shuffled' });
  });

  it('un tope por noche menor que el máximo por cobro → 400 y no se guarda', async () => {
    const { ctrl, tx } = make({ nightSettings: { nfcNoPinMaxCents: 3_000, nfcNoPinNightCapCents: 5_000 } });
    await expect(ctrl.updateNight(owner, { nfcNoPinNightCapCents: 2_000 })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.venue.update).not.toHaveBeenCalled();
  });
});

describe('VenuesController /v1/venues/me', () => {
  it('lleva las formas de cobro y los ajustes de la noche completos (las apps del personal)', async () => {
    const prisma = {
      venue: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: 't-1',
          name: 'Sala Bambú',
          slug: 'bambu',
          timezone: 'Europe/Madrid',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          paymentMethods: { pos: false },
          nightSettings: { pinKeypad: 'shuffled' },
        })),
      },
      // El mapa del dinero: el puesto de quien llama (la chica, siempre Sala).
      user: { findFirst: vi.fn(async () => ({ post: null })) },
    };
    const ctrl = new VenuesController(prisma as never);
    const me = await ctrl.getMyVenue({ sub: 'u', role: 'OPERATOR', tenantId: 't-1' } as JwtPayload);
    expect(me.paymentMethods).toMatchObject({ pos: false, card: true });
    expect(me.nightSettings).toEqual({ ...DEFAULT_NIGHT_SETTINGS, pinKeypad: 'shuffled' });
    expect(me).toMatchObject({ myPost: 'SALA', myRights: { sections: ['CHICA_SERVICE'] }, myDefaultCategory: 'CHICA_SERVICE' });
  });
});
