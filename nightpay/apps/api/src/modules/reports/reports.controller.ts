import { BadRequestException, ConflictException, Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BLIND_CASH_CONFLICT, blindsCash, overlapsOpenNight } from '../nights/blind-cash';
import type { FastifyReply } from 'fastify';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  cobrosCsv,
  devolucionesCsv,
  liquidacionesCsv,
  recargasEfectivoCsv,
  recargasSociosCsv,
  resumenCsv,
  saldoDevueltoCsv,
  summarize,
} from './export-csv';
import { parseReportPeriod, periodSlug, type ReportPeriod } from './report-period';
import { ReportsService } from './reports.service';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';

const KINDS = ['cobros', 'devoluciones', 'liquidaciones', 'resumen', 'recargas-efectivo', 'recargas-socios', 'saldo-devuelto'] as const;
type ExportKind = (typeof KINDS)[number];

/**
 * Los que llevan efectivo de caja: las recargas en efectivo, el saldo
 * devuelto, los pagos al personal (en mano), las devoluciones (alguna se paga
 * en efectivo) y el resumen, que los suma. Con la noche abierta, a la
 * encargada no le salen si el periodo llega a ella (cierre a ciegas).
 * «recargas-socios» no: es el efectivo de los cajeros de otras plataformas,
 * no el del cajón de recepción (y ya se ve en «Movimientos»).
 */
const CASH_KINDS: ReadonlySet<ExportKind> = new Set(['devoluciones', 'liquidaciones', 'resumen', 'recargas-efectivo', 'saldo-devuelto']);

/**
 * Informes para la gestoría en CSV (Fase 1C). El dueño, y el encargado si el
 * dueño se lo deja (Ajustes → Permisos → ver informes): datos fiscales.
 *   GET /v1/admin/export/{cobros|devoluciones|liquidaciones|resumen|recargas-efectivo|recargas-socios|saldo-devuelto}?from=AAAA-MM-DD&to=AAAA-MM-DD
 * Días de Madrid, ambos incluidos. Con la noche abierta, a la encargada los
 * de efectivo (CASH_KINDS) de un periodo que llegue a ella: 409 «Se ve al
 * cerrar la noche».
 */
@Controller('admin/export')
@UseGuards(RolesGuard)
export class ReportsController {
  private readonly reports: ReportsService;

  constructor(@Inject(ReportsService) reports: ReportsService) {
    this.reports = reports;
  }

  @Get(':kind')
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('reports')
  async export(
    @CurrentUser() user: JwtPayload,
    @Tenant() tenantId: string,
    @Param('kind') kind: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    if (!isKind(kind)) throw new BadRequestException(`Informe desconocido: usa ${KINDS.join(', ')}`);
    const parsed = parseReportPeriod(from ?? '', to ?? '');
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    if (user.role === 'MANAGER' && CASH_KINDS.has(kind)) {
      const openFrom = await this.reports.openNightStart(tenantId);
      if (blindsCash(user.role, openFrom !== null) && overlapsOpenNight(parsed.period.to, openFrom)) {
        throw new ConflictException(BLIND_CASH_CONFLICT);
      }
    }
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
        const [rows, venueName, labelOf] = await Promise.all([
          this.reports.cobros(tenantId, period),
          this.reports.venueName(tenantId),
          this.reports.sectionLabeler(tenantId),
        ]);
        return cobrosCsv(rows, venueName, labelOf);
      }
      case 'devoluciones':
        return devolucionesCsv(await this.reports.devoluciones(tenantId, period));
      case 'liquidaciones':
        return liquidacionesCsv(await this.reports.liquidaciones(tenantId, period));
      case 'recargas-efectivo':
        return recargasEfectivoCsv(await this.reports.recargasEfectivo(tenantId, period));
      case 'recargas-socios':
        // Las cargas de los cajeros de otras plataformas (API de socios): sin la API, vacío.
        return recargasSociosCsv(await this.reports.recargasSocios(tenantId, period));
      case 'saldo-devuelto':
        return saldoDevueltoCsv(await this.reports.pagosSaldo(tenantId, period));
      case 'resumen': {
        const [cobros, devoluciones, liquidaciones, consumos, pagosSaldo, recargasEfectivo, venueName, labelOf] = await Promise.all([
          this.reports.cobros(tenantId, period),
          this.reports.devoluciones(tenantId, period),
          this.reports.liquidaciones(tenantId, period),
          this.reports.consumos(tenantId, period),
          this.reports.pagosSaldo(tenantId, period),
          this.reports.recargasEfectivo(tenantId, period),
          this.reports.venueName(tenantId),
          this.reports.sectionLabeler(tenantId),
        ]);
        return resumenCsv({
          venueName,
          period,
          generatedAt: new Date(),
          summary: summarize(cobros, devoluciones, liquidaciones, consumos, pagosSaldo, recargasEfectivo, { labelOf }),
        });
      }
    }
  }
}

function isKind(kind: string): kind is ExportKind {
  return (KINDS as readonly string[]).includes(kind);
}
