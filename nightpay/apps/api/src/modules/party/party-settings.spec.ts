import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { PartySettingsController } from './party-settings.controller';
import { partySettingsView, planPartySettingsChange, type PartySettingsRow } from './party-settings';

/** Ajustes de la fiesta: vista, cambio (solo lo que cambia, fin después del inicio) y el controlador (2FA, registro). */

const T = 't-1';
const owner = { sub: 'owner-1', email: 'duena@fiesta.es', role: 'OWNER', tenantId: T, venueSlug: 'fiesta' } as JwtPayload;

const STORED: PartySettingsRow = {
  eventStartsAt: new Date('2026-03-15T10:00:00Z'),
  eventEndsAt: new Date('2026-03-20T05:00:00Z'),
  refundDeadline: new Date('2026-04-30T00:00:00Z'),
  allowDonation: true,
  cashAlertCents: 200_000,
};

describe('vista', () => {
  it('fechas ISO, el plazo como AAAA-MM-DD y si ya terminó', () => {
    expect(partySettingsView(STORED, new Date('2026-03-18T00:00:00Z'))).toEqual({
      eventStartsAt: '2026-03-15T10:00:00.000Z',
      eventEndsAt: '2026-03-20T05:00:00.000Z',
      refundDeadline: '2026-04-30',
      allowDonation: true,
      cashAlertCents: 200_000,
      eventEnded: false,
    });
    expect(partySettingsView(STORED, new Date('2026-03-20T05:00:00Z')).eventEnded).toBe(true);
    const empty = partySettingsView({ ...STORED, eventStartsAt: null, eventEndsAt: null, refundDeadline: null });
    expect(empty).toMatchObject({ eventStartsAt: null, eventEndsAt: null, refundDeadline: null, eventEnded: false });
  });
});

describe('cambio', () => {
  it('solo lo que cambia de verdad (la misma hora con otra zona no cuenta)', () => {
    const plan = planPartySettingsChange(STORED, {
      eventEndsAt: '2026-03-20T06:00:00+01:00',
      refundDeadline: '2026-05-15',
      allowDonation: false,
      cashAlertCents: 200_000,
    });
    expect(plan).toEqual({ ok: true, change: { refundDeadline: new Date('2026-05-15T00:00:00Z'), allowDonation: false } });
  });

  it('borrar fechas (null) vale', () => {
    const plan = planPartySettingsChange(STORED, { eventStartsAt: null, eventEndsAt: null, refundDeadline: null });
    expect(plan).toEqual({ ok: true, change: { eventStartsAt: null, eventEndsAt: null, refundDeadline: null } });
  });

  it('el fin antes del inicio (también contra lo guardado): no vale', () => {
    expect(planPartySettingsChange(STORED, { eventEndsAt: '2026-03-15T09:00:00Z' })).toMatchObject({ ok: false });
    expect(planPartySettingsChange(STORED, { eventStartsAt: '2026-03-21T00:00:00Z' })).toMatchObject({ ok: false });
    expect(planPartySettingsChange(STORED, { cashAlertCents: 50_000 })).toEqual({ ok: true, change: { cashAlertCents: 50_000 } });
  });
});

describe('PartySettingsController', () => {
  function make() {
    const update = vi.fn(async ({ data }: { data: Partial<PartySettingsRow> }) => ({ ...STORED, ...data }));
    const tx = { venue: { findUniqueOrThrow: vi.fn().mockResolvedValue(STORED), update } };
    const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const totp = { assertIfEnrolledForUser: vi.fn().mockResolvedValue(undefined) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const ctrl = new PartySettingsController(prisma as never, totp as never, audit as never);
    return { ctrl, update, totp, audit, tx };
  }

  it('lee los del local', async () => {
    const { ctrl, tx } = make();
    await expect(ctrl.settings(owner)).resolves.toMatchObject({ refundDeadline: '2026-04-30', cashAlertCents: 200_000 });
    expect(tx.venue.findUniqueOrThrow.mock.calls[0]![0]).toMatchObject({ where: { id: T } });
  });

  it('cambiar pide la 2FA (si la tiene), guarda solo lo cambiado y lo registra con antes y después', async () => {
    const { ctrl, update, totp, audit } = make();
    const after = await ctrl.update(owner, { allowDonation: false, cashAlertCents: 100_000, totpCode: '123456' });
    expect(totp.assertIfEnrolledForUser).toHaveBeenCalledWith('owner-1', '123456');
    expect(update.mock.calls[0]![0]).toMatchObject({ where: { id: T }, data: { allowDonation: false, cashAlertCents: 100_000 } });
    expect(after).toMatchObject({ allowDonation: false, cashAlertCents: 100_000 });
    expect(audit.log.mock.calls[0]![0]).toMatchObject({
      action: 'party.settings.updated',
      targetType: 'Venue',
      payload: { before: { allowDonation: true, cashAlertCents: 200_000 }, after: { allowDonation: false, cashAlertCents: 100_000 } },
    });
  });

  it('sin cambios: ni 2FA ni escritura', async () => {
    const { ctrl, update, totp } = make();
    await ctrl.update(owner, { allowDonation: true });
    expect(totp.assertIfEnrolledForUser).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('el fin antes del inicio: 400 y no se guarda', async () => {
    const { ctrl, update } = make();
    await expect(ctrl.update(owner, { eventEndsAt: '2026-03-14T00:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
});
