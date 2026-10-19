import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ReportsController } from './reports.controller';

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
  };
  return { controller: new ReportsController(reports as never), reports };
}

describe('GET /v1/admin/export/:kind', () => {
  it('descarga el CSV del mes con nombre de archivo y sin caché', async () => {
    const { controller, reports } = makeController();
    const { reply, sent } = fakeReply();
    await controller.export('t-1', 'cobros', '2026-10-01', '2026-10-31', reply);
    expect(reports.cobros).toHaveBeenCalledWith('t-1', expect.objectContaining({ fromDay: '2026-10-01' }));
    expect(sent.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(sent.headers['Content-Disposition']).toBe('attachment; filename="cobros-2026-10.csv"');
    expect(sent.headers['Cache-Control']).toBe('no-store');
    expect(sent.body?.startsWith('\uFEFFFecha;Hora;Local')).toBe(true);
  });

  it('el resumen junta cobros, devoluciones y pagos del local', async () => {
    const { controller, reports } = makeController();
    const { reply, sent } = fakeReply();
    await controller.export('t-1', 'resumen', '2026-07-01', '2026-09-30', reply);
    expect(reports.devoluciones).toHaveBeenCalled();
    expect(reports.liquidaciones).toHaveBeenCalled();
    expect(sent.body).toContain('Resumen para la gestoría;Local Centro');
    // El saldo devuelto en efectivo también cuenta (antes no salía en ningún informe).
    expect(reports.pagosSaldo).toHaveBeenCalledWith('t-1', expect.objectContaining({ fromDay: '2026-07-01' }));
    expect(sent.body).toContain('Saldo devuelto en efectivo;-80,00;1');
    expect(sent.body).toContain('Neto cobrado;-80,00');
  });

  it('informe desconocido o fechas mal → 400 sin consultar nada', async () => {
    const { controller, reports } = makeController();
    const { reply } = fakeReply();
    await expect(controller.export('t-1', 'nominas', '2026-10-01', '2026-10-31', reply)).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.export('t-1', 'cobros', undefined, '2026-10-31', reply)).rejects.toThrow(
      BadRequestException,
    );
    expect(reports.cobros).not.toHaveBeenCalled();
  });
});
