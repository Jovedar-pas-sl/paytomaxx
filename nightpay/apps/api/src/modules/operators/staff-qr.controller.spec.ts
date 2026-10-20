import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StaffQrController } from './staff-qr.controller';
import { signStaffToken } from './staff-qr';

process.env.JWT_SECRET ??= 'clave-de-las-pruebas-de-la-api-0123456789';

const SALA = '3c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f';
const OTRO = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NEREA = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const CARLOS = '0b7a0c5e-1d2e-4f3a-9b8c-7d6e5f4a3b2c';

const carlos = { sub: CARLOS, tenantId: SALA, role: 'WAITER' } as never;

function make(o: { chica?: { id: string; displayName: string | null; email: string } | null; rules?: unknown } = {}) {
  const tx = {
    user: {
      findFirst: vi.fn(async () => (o.chica === undefined ? { id: NEREA, displayName: 'Nerea', email: 'nerea@luna.es' } : o.chica)),
      findMany: vi.fn(async () => [
        { id: NEREA, displayName: 'Nerea', email: 'nerea@luna.es' },
        { id: OTRO, displayName: null, email: 'lola.sala@luna.es' },
      ]),
    },
    venue: { findUniqueOrThrow: vi.fn(async () => ({ invitationRules: o.rules ?? null })) },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { controller: new StaffQrController({ get: () => undefined } as never, prisma as never), tx };
}

const qrOf = (userId: string, tenantId = SALA, at = Date.now()) =>
  `https://op.luna.es/?invita=${signStaffToken({ userId, tenantId }, at, process.env.JWT_SECRET!).token}`;

describe('el camarero lee el QR de la chica: «Nerea reconocida»', () => {
  it('su nombre, del QR de su local y sin caducar', async () => {
    const { controller, tx } = make();
    expect(await controller.resolve(carlos, { token: qrOf(NEREA) })).toEqual({ id: NEREA, name: 'Nerea' });
    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: NEREA, tenantId: SALA, role: 'OPERATOR', deletedAt: null }) }),
    );
  });

  it('de otro local, caducado, suyo o de alguien que no es chica → 400', async () => {
    const { controller } = make();
    await expect(controller.resolve(carlos, { token: qrOf(NEREA, OTRO) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.resolve(carlos, { token: qrOf(NEREA, SALA, Date.now() - 3_600_000) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.resolve(carlos, { token: qrOf(CARLOS) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(make({ chica: null }).controller.resolve(carlos, { token: qrOf(NEREA) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.resolve(carlos, { token: 'no-es-un-qr-de-una-chica-de-verdad' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('elegir a la chica de la lista', () => {
  it('con el QR obligatorio (de fábrica) → 403', async () => {
    await expect(make().controller.invitables(carlos)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('si el local no pide el QR: las chicas del local, con su nombre (o el de su correo)', async () => {
    const { controller, tx } = make({ rules: { requireQr: false } });
    expect(await controller.invitables(carlos)).toEqual([
      { id: NEREA, name: 'Nerea' },
      { id: OTRO, name: 'lola.sala' },
    ]);
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: SALA, role: 'OPERATOR', deletedAt: null }) }),
    );
  });
});
