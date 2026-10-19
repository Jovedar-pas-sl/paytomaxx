import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { TerminalsService } from './terminals.service';

/**
 * Datáfonos de Sala Bambú (Madrid): alta, alta en bloque, edición y baja.
 * Todo por local: el externalId es único dentro del venue y un terminal de
 * otro local no existe para quien no es su dueño.
 */

const SALA_BAMBU = '7d3f2a10-5b6c-4e8d-9f01-2a3b4c5d6e7f';
const DUENO = '0b5e8c2a-6d4f-4e1a-9b3c-5d7e9f1a3b5c';
const TPV_ID = '3e5a7c9b-1d2f-4a6b-8c0d-2e4f6a8b0c1d';

interface Fila {
  id: string;
  tenantId: string;
  externalId: string;
  label: string;
  zone: string | null;
  hardwareModel: string | null;
  deviceSerial: string | null;
  active: boolean;
  deviceTokenHash: string | null;
  deviceLastSeenAt: Date | null;
}

function fila(overrides: Partial<Fila> = {}): Fila {
  return {
    id: TPV_ID,
    tenantId: SALA_BAMBU,
    externalId: 'PAX-BARRA-1',
    label: 'PAX BARRA 1',
    zone: 'BARRA',
    hardwareModel: 'PAX_A920_PRO',
    deviceSerial: '1850123456',
    active: true,
    deviceTokenHash: null,
    deviceLastSeenAt: null,
    ...overrides,
  };
}

function montar(opts: { existente?: Fila | null; previos?: Array<{ externalId: string }>; tpv?: Fila | null } = {}) {
  const terminal = {
    findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
    findUnique: vi.fn(async (_args: unknown) => opts.existente ?? null),
    findFirst: vi.fn(async (_args: unknown) => opts.tpv ?? null),
    create: vi.fn(async (args: { data: Partial<Fila> }) => fila({ ...args.data, id: TPV_ID })),
    createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
    update: vi.fn(async (args: { data: Partial<Fila> }) => fila({ ...opts.tpv, ...args.data })),
  };
  const $queryRaw = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as unknown[]);
  const audit = { log: vi.fn(async (_entry: Record<string, unknown>) => undefined) };
  const svc = new TerminalsService({ terminal, $queryRaw } as never, audit as never);
  return { svc, terminal, $queryRaw, audit };
}

describe('TerminalsService.list / listZones — solo los del local', () => {
  it('list filtra por el venue y nunca devuelve la credencial del datáfono', async () => {
    const h = montar();
    h.terminal.findMany.mockResolvedValueOnce([
      fila({ deviceTokenHash: 'sha256:9f2c…', deviceLastSeenAt: new Date('2026-10-17T00:12:00+02:00') }),
      fila({ id: 'b1', externalId: 'PAX-HAB-1', zone: 'OTRO/VIP ROOM' }),
    ]);
    const vistas = await h.svc.list(SALA_BAMBU);
    expect(h.terminal.findMany).toHaveBeenCalledWith({
      where: { tenantId: SALA_BAMBU },
      orderBy: [{ zone: 'asc' }, { externalId: 'asc' }],
    });
    expect(vistas[0]).toMatchObject({ devicePaired: true, deviceLastSeenAt: '2026-10-16T22:12:00.000Z', zoneDisplay: 'Barra' });
    expect(vistas[1]).toMatchObject({ devicePaired: false, deviceLastSeenAt: null, zoneDisplay: 'Vip room' });
    expect(JSON.stringify(vistas)).not.toContain('sha256');
    expect(vistas[0]).not.toHaveProperty('deviceTokenHash');
    expect(vistas[0]).not.toHaveProperty('tenantId');
  });

  it('listZones: SQL filtrado por el venue y contadores bigint → number', async () => {
    const h = montar();
    let consulta: Prisma.Sql | undefined;
    h.$queryRaw.mockImplementationOnce(async (strings, ...values) => {
      consulta = Prisma.sql(strings, ...values);
      return [
        { zone: 'BARRA', total: 4n, activeCount: 3n },
        { zone: 'OTRO/TERRAZA', total: 1n, activeCount: 0n },
      ];
    });
    await expect(h.svc.listZones(SALA_BAMBU)).resolves.toEqual([
      { zone: 'BARRA', zoneDisplay: 'Barra', terminalCount: 4, activeCount: 3 },
      { zone: 'OTRO/TERRAZA', zoneDisplay: 'Terraza', terminalCount: 1, activeCount: 0 },
    ]);
    expect(consulta?.text).toContain('"tenantId" = $');
    expect(consulta?.values).toContain(SALA_BAMBU);
  });
});

describe('TerminalsService.create — alta de un datáfono', () => {
  const alta = {
    externalId: 'PAX-BARRA-5',
    label: 'Barra principal',
    zone: 'BARRA' as const,
    hardwareModel: 'PAX_A920_PRO' as const,
    deviceSerial: '1850999001',
    active: true,
  };

  it('externalId ya usado en el venue → Conflict y no se crea ni audita', async () => {
    const h = montar({ existente: fila({ externalId: 'PAX-BARRA-5' }) });
    await expect(h.svc.create(SALA_BAMBU, DUENO, alta)).rejects.toBeInstanceOf(ConflictException);
    expect(h.terminal.findUnique).toHaveBeenCalledWith({
      where: { tenantId_externalId: { tenantId: SALA_BAMBU, externalId: 'PAX-BARRA-5' } },
    });
    expect(h.terminal.create).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('crea en el venue del que llama, con la zona canónica, y lo audita', async () => {
    const h = montar();
    const vista = await h.svc.create(SALA_BAMBU, DUENO, { ...alta, zone: 'OTRO', zoneCustom: ' vip room ' });
    expect(h.terminal.create).toHaveBeenCalledWith({
      data: {
        tenantId: SALA_BAMBU,
        externalId: 'PAX-BARRA-5',
        label: 'Barra principal',
        active: true,
        zone: 'OTRO/VIP ROOM',
        hardwareModel: 'PAX_A920_PRO',
        deviceSerial: '1850999001',
      },
    });
    expect(h.audit.log).toHaveBeenCalledWith({
      action: 'terminal.created',
      tenantId: SALA_BAMBU,
      actorId: DUENO,
      targetType: 'Terminal',
      targetId: TPV_ID,
      payload: { externalId: 'PAX-BARRA-5', zone: 'OTRO/VIP ROOM' },
    });
    expect(vista).toMatchObject({ id: TPV_ID, zoneDisplay: 'Vip room', devicePaired: false });
  });

  it('sin modelo ni número de serie → se guardan como null (no undefined)', async () => {
    const h = montar();
    await h.svc.create(SALA_BAMBU, DUENO, { externalId: 'T-1', label: 'Caja', active: false });
    expect(h.terminal.create.mock.calls[0]?.[0]).toMatchObject({
      data: { hardwareModel: null, deviceSerial: null, zone: null, active: false },
    });
  });
});

describe('TerminalsService.bulkCreate — alta en bloque con prefijo', () => {
  it('sin zona válida (OTRO sin nombre) → BadRequest y no se crea nada', async () => {
    const h = montar();
    await expect(
      h.svc.bulkCreate(SALA_BAMBU, DUENO, { count: 2, prefix: 'PAX-', zone: 'OTRO', hardwareModel: 'PAX_A920_PRO' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.terminal.createMany).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('continúa la numeración del prefijo en el venue, ignorando sufijos no numéricos', async () => {
    const h = montar();
    h.terminal.findMany.mockResolvedValueOnce([
      { externalId: 'PAX-BARRA-1' },
      { externalId: 'PAX-BARRA-3' },
      { externalId: 'PAX-BARRA-RESERVA' },
    ]);
    await h.svc.bulkCreate(SALA_BAMBU, DUENO, { count: 2, prefix: 'PAX-BARRA-', zone: 'BARRA', hardwareModel: 'INGENICO_IM30' });
    expect(h.terminal.findMany.mock.calls[0]?.[0]).toEqual({
      where: { tenantId: SALA_BAMBU, externalId: { startsWith: 'PAX-BARRA-' } },
      select: { externalId: true },
    });
    expect(h.terminal.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: SALA_BAMBU, externalId: 'PAX-BARRA-4', label: 'PAX-BARRA 4', active: true, zone: 'BARRA', hardwareModel: 'INGENICO_IM30', deviceSerial: null },
        { tenantId: SALA_BAMBU, externalId: 'PAX-BARRA-5', label: 'PAX-BARRA 5', active: true, zone: 'BARRA', hardwareModel: 'INGENICO_IM30', deviceSerial: null },
      ],
    });
    expect(h.audit.log).toHaveBeenCalledWith({
      action: 'terminal.bulk_created',
      tenantId: SALA_BAMBU,
      actorId: DUENO,
      targetType: 'Terminal',
      targetId: 'bulk',
      payload: { count: 2, zone: 'BARRA', prefix: 'PAX-BARRA-' },
    });
    // Devuelve solo las recién creadas del venue.
    expect(h.terminal.findMany.mock.calls[1]?.[0]).toEqual({
      where: { tenantId: SALA_BAMBU, externalId: { in: ['PAX-BARRA-4', 'PAX-BARRA-5'] } },
      orderBy: { externalId: 'asc' },
    });
  });

  it('sin previos empieza en 1', async () => {
    const h = montar();
    await h.svc.bulkCreate(SALA_BAMBU, DUENO, { count: 1, prefix: 'HAB-', zone: 'HABITACIONES', hardwareModel: 'PAX_A920_PRO' });
    expect(h.terminal.createMany.mock.calls[0]?.[0]).toMatchObject({ data: [{ externalId: 'HAB-1', label: 'HAB 1' }] });
  });
});

describe('TerminalsService.update — edición y baja', () => {
  it('terminal de otro venue (o inexistente) → NotFound, sin escribir ni auditar', async () => {
    const h = montar({ tpv: null });
    await expect(h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { active: false })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.terminal.findFirst).toHaveBeenCalledWith({ where: { id: TPV_ID, tenantId: SALA_BAMBU } });
    expect(h.terminal.update).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('baja: escribe solo active=false y lo audita', async () => {
    const h = montar({ tpv: fila() });
    const vista = await h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { active: false });
    expect(h.terminal.update).toHaveBeenCalledWith({ where: { id: TPV_ID }, data: { active: false } });
    expect(h.audit.log).toHaveBeenCalledWith({
      action: 'terminal.updated',
      tenantId: SALA_BAMBU,
      actorId: DUENO,
      targetType: 'Terminal',
      targetId: TPV_ID,
      payload: { changes: { active: false } },
    });
    expect(vista.active).toBe(false);
  });

  it('zona null la borra; OTRO + nombre la canoniza; campos no enviados no se tocan', async () => {
    const h = montar({ tpv: fila() });
    await h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { zone: null });
    expect(h.terminal.update.mock.calls[0]?.[0]).toEqual({ where: { id: TPV_ID }, data: { zone: null } });

    await h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { label: 'Terraza 2', zone: 'OTRO', zoneCustom: 'terraza' });
    expect(h.terminal.update.mock.calls[1]?.[0]).toEqual({
      where: { id: TPV_ID },
      data: { label: 'Terraza 2', zone: 'OTRO/TERRAZA' },
    });
  });

  // Antes la edición no exigía el nombre con zona OTRO (el alta sí): escribía
  // zone=null y el datáfono desaparecía de su zona.
  it('zona OTRO sin nombre en la edición → BadRequest, no borra la zona', async () => {
    const h = montar({ tpv: fila() });
    await expect(h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { zone: 'OTRO' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.terminal.update).not.toHaveBeenCalled();
  });

  it('modelo y número de serie se pueden vaciar con null', async () => {
    const h = montar({ tpv: fila() });
    await h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { hardwareModel: null, deviceSerial: null });
    expect(h.terminal.update.mock.calls[0]?.[0]).toEqual({
      where: { id: TPV_ID },
      data: { hardwareModel: null, deviceSerial: null },
    });
  });
});

describe('TerminalsService.update — datáfono de la recepción (dinero #5)', () => {
  it('el dueño lo marca; el encargado no (403, sin escribir)', async () => {
    const h = montar({ tpv: fila() });
    await h.svc.update(SALA_BAMBU, TPV_ID, DUENO, { reception: true }, 'OWNER');
    expect(h.terminal.update).toHaveBeenCalledWith({ where: { id: TPV_ID }, data: { reception: true } });
    const m = montar({ tpv: fila() });
    await expect(m.svc.update(SALA_BAMBU, TPV_ID, DUENO, { reception: true }, 'MANAGER')).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.terminal.update).not.toHaveBeenCalled();
    // El resto lo sigue editando el encargado.
    await m.svc.update(SALA_BAMBU, TPV_ID, DUENO, { label: 'Barra 2' }, 'MANAGER');
    expect(m.terminal.update).toHaveBeenCalled();
  });
});
