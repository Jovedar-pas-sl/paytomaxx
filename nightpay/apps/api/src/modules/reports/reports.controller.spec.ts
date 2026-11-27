import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { venueSectionLabeler } from './export-rows';
import { ReportsController } from './reports.controller';

const owner = { sub: 'u-1', tenantId: 't-1', role: 'OWNER' } as never;

function fakeReply() {
  const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return reply;
    },
    send(body?: string) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

function makeController() {
  const reports = {
    cobros: vi.fn().mockResolvedValue([]),
    devoluciones: vi.fn().mockResolvedValue([]),
    liquidaciones: vi.fn().mockResolvedValue([]),
    consumos: vi.fn().mockResolvedValue([]),
    pagosSaldo: vi.fn().mockResolvedValue([
      { id: 'wp-1', at: new Date('2026-08-01T03:00:00Z'), amountCents: 8000, method: 'CASH', paidByName: null, paidByEmail: 'jefe@local.es' },
    ]),
    recargasEfectivo: vi.fn().mockResolvedValue([]),
    venueName: vi.fn().mockResolvedValue('Local Centro'),
    sectionLabeler: vi.fn().mockResolvedValue(venueSectionLabeler(null)),
  };
  return { controller: new ReportsController(reports as never), reports };
}

describe('GET /v1/admin/export/:kind', () => {
  it('descarga el CSV del mes con nombre de archivo y sin caché', async () => {
    const { controller, reports } = makeController();
    const { reply, sent } = fakeReply();
    await controller.export(owner, 't-1', 'cobros', '2026-10-01', '2026-10-31', reply);
    expect(reports.cobros).toHaveBeenCalledWith('t-1', expect.objectContaining({ fromDay: '2026-10-01' }));
    expect(sent.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(sent.headers['Content-Disposition']).toBe('attachment; filename="cobros-2026-10.csv"');
    expect(sent.headers['Cache-Control']).toBe('no-store');
    expect(sent.body?.startsWith('\uFEFFFecha;Hora;Local')).toBe(true);
  });

  it('el resumen junta cobros, devoluciones y pagos del local', async () => {
    const { controller, reports } = makeController();
    const { reply, sent } = fakeReply();
    await controller.export(owner, 't-1', 'resumen', '2026-07-01', '2026-09-30', reply);
    expect(reports.devoluciones).toHaveBeenCalled();
    expect(reports.liquidaciones).toHaveBeenCalled();
    expect(sent.body).toContain('Resumen para la gestoría;Local Centro');
    // El saldo devuelto en efectivo también cuenta (antes no salía en ningún informe).
    expect(reports.pagosSaldo).toHaveBeenCalledWith('t-1', expect.objectContaining({ fromDay: '2026-07-01' }));
    expect(sent.body).toContain('Saldo devuelto en efectivo;-80,00;1');
    expect(sent.body).toContain('Neto cobrado;-80,00');
  });

  it('«recargas-efectivo» y «saldo-devuelto»: el detalle del efectivo para la gestoría', async () => {
    const { controller, reports } = makeController();
    const one = fakeReply();
    await controller.export(owner, 't-1', 'recargas-efectivo', '2026-10-01', '2026-10-31', one.reply);
    expect(reports.recargasEfectivo).toHaveBeenCalledWith('t-1', expect.objectContaining({ fromDay: '2026-10-01' }));
    expect(one.sent.headers['Content-Disposition']).toBe('attachment; filename="recargas-efectivo-2026-10.csv"');
    const two = fakeReply();
    await controller.export(owner, 't-1', 'saldo-devuelto', '2026-10-01', '2026-10-31', two.reply);
    expect(two.sent.body).toMatch(/;80,00;Efectivo;/);
  });

  it('informe desconocido o fechas mal → 400 sin consultar nada', async () => {
    const { controller, reports } = makeController();
    const { reply } = fakeReply();
    await expect(controller.export(owner, 't-1', 'nominas', '2026-10-01', '2026-10-31', reply)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.export(owner, 't-1', 'cobros', undefined, '2026-10-31', reply)).rejects.toThrow(
      BadRequestException,
    );
    expect(reports.cobros).not.toHaveBeenCalled();
  });
});

describe('los CSV de la gestoría con los nombres de sección del local', () => {
  /** Nachos 9 € (VENUE_FOOD, que el local llama «Cocina»), cobrado con tarjeta. */
  const NACHOS = {
    id: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
    paidAt: new Date('2026-10-22T21:00:00Z'),
    status: 'AUTHORIZED',
    amountCents: 900,
    tipCents: 0,
    revenueCategory: 'VENUE_FOOD',
    lines: [{ category: 'VENUE_FOOD', amountCents: 900 }],
    captureMethod: 'QR',
    serviceName: null,
    payMethod: 'card',
    walletId: null,
    creatorName: 'Paula',
    creatorEmail: 'paula@local.es',
    earningOperatorName: null,
    earningOperatorEmail: null,
    refundedCents: 0,
    commissionCents: null,
    earningTipCents: null,
    reversedCents: null,
    reversedAfterPayoutCents: 0,
  };

  it('libro de cobros y resumen: «Cocina», no «Comida»', async () => {
    const { controller, reports } = makeController();
    reports.sectionLabeler.mockResolvedValue(venueSectionLabeler({ VENUE_FOOD: { label: 'Cocina' } }));
    reports.cobros.mockResolvedValue([NACHOS]);
    const libro = fakeReply();
    await controller.export(owner, 't-1', 'cobros', '2026-10-01', '2026-10-31', libro.reply);
    expect(libro.sent.body).toContain(';Cocina;Cocina;Paula;');
    expect(libro.sent.body).toContain(';Cocina 9,00');
    const resumen = fakeReply();
    await controller.export(owner, 't-1', 'resumen', '2026-10-01', '2026-10-31', resumen.reply);
    expect(resumen.sent.body).toContain('Cocina;9,00;1');
    for (const body of [libro.sent.body, resumen.sent.body]) expect(body).not.toContain('Comida');
    expect(reports.sectionLabeler).toHaveBeenCalledWith('t-1');
  });
});
