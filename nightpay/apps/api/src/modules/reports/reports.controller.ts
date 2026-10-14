import { BadRequestException, Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { cobrosCsv, devolucionesCsv, liquidacionesCsv, resumenCsv, summarize } from './export-csv';
import { parseReportPeriod, periodSlug, type ReportPeriod } from './report-period';
import { ReportsService } from './reports.service';

const KINDS = ['cobros', 'devoluciones', 'liquidaciones', 'resumen'] as const;
type ExportKind = (typeof KINDS)[number];

/**
 * Informes para la gestoría en CSV (Fase 1C). Solo el dueño: datos fiscales.
 *   GET /v1/admin/export/{cobros|devoluciones|liquidaciones|resumen}?from=AAAA-MM-DD&to=AAAA-MM-DD
 * Días de Madrid, ambos incluidos.
 */
@Controller('admin/export')
@UseGuards(RolesGuard)
export class ReportsController {
  private readonly reports: ReportsService;

  constructor(@Inject(ReportsService) reports: ReportsService) {
    this.reports = reports;
  }

  @Get(':kind')
  @Roles('OWNER')
  async export(
    @Tenant() tenantId: string,
    @Param('kind') kind: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    if (!isKind(kind)) throw new BadRequestException(`Informe desconocido: usa ${KINDS.join(', ')}`);
    const parsed = parseReportPeriod(from ?? '', to ?? '');
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const csv = await this.build(kind, tenantId, parsed.period);
    res
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${kind}-${periodSlug(parsed.period)}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(csv);
  }

  private async build(kind: ExportKind, tenantId: string, period: ReportPeriod): Promise<string> {
    switch (kind) {
      case 'cobros': {
        const [rows, venueName] = await Promise.all([
          this.reports.cobros(tenantId, period),
          this.reports.venueName(tenantId),
        ]);
        return cobrosCsv(rows, venueName);
      }
      case 'devoluciones':
        return devolucionesCsv(await this.reports.devoluciones(tenantId, period));
      case 'liquidaciones':
        return liquidacionesCsv(await this.reports.liquidaciones(tenantId, period));
      case 'resumen': {
        const [cobros, devoluciones, liquidaciones, consumos, venueName] = await Promise.all([
          this.reports.cobros(tenantId, period),
          this.reports.devoluciones(tenantId, period),
          this.reports.liquidaciones(tenantId, period),
          this.reports.consumos(tenantId, period),
          this.reports.venueName(tenantId),
        ]);
        return resumenCsv({
          venueName,
          period,
          generatedAt: new Date(),
          summary: summarize(cobros, devoluciones, liquidaciones, consumos),
        });
      }
    }
  }
}

function isKind(kind: string): kind is ExportKind {
  return (KINDS as readonly string[]).includes(kind);
}
