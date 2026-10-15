import { Controller, Get, Inject, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PeriodReportsService } from './period-reports.service';
import { madridTodayWindow } from './reporting-window';

/** Z de un periodo: from/to en ISO. Sin from, desde las 00:00 de hoy en Madrid; sin to, hasta ahora. */
const ZReportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
type ZReportQuery = z.infer<typeof ZReportQuerySchema>;

/** IVA 303: "Q1-2026"… Sin trimestre, el actual (en Madrid). */
const VatReportQuerySchema = z.object({
  quarter: z
    .string()
    .regex(/^Q[1-4]-\d{4}$/, 'Formato: Q1-2026, Q2-2026, etc.')
    .optional(),
});
type VatReportQuery = z.infer<typeof VatReportQuerySchema>;

/**
 * Métricas del panel, Z de un periodo e IVA 303 (mismas rutas que tenían en
 * AdminController). Las cuentas, en PeriodReportsService.
 *  - GET /v1/admin/metrics
 *  - GET /v1/admin/reports/z?from=&to=
 *  - GET /v1/admin/reports/vat-303?quarter=Q1-2026 (solo el dueño: datos fiscales)
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class PeriodReportsController {
  private readonly reports: PeriodReportsService;

  constructor(@Inject(PeriodReportsService) reports: PeriodReportsService) {
    this.reports = reports;
  }

  @Get('metrics')
  @Roles('OWNER', 'MANAGER')
  async metrics(@Tenant() tenantId: string) {
    return this.reports.metrics(tenantId);
  }

  @Get('reports/z')
  @Roles('OWNER', 'MANAGER')
  async zReport(@Tenant() tenantId: string, @Query(new ZodValidationPipe(ZReportQuerySchema)) q: ZReportQuery) {
    const now = new Date();
    const from = q.from ? new Date(q.from) : madridTodayWindow(now).from;
    const to = q.to ? new Date(q.to) : now;
    if (from >= to) {
      throw new NotFoundException('from debe ser anterior a to');
    }
    return this.reports.periodZ(tenantId, { from, to }, now);
  }

  @Get('reports/vat-303')
  @Roles('OWNER')
  async vatReport(@Tenant() tenantId: string, @Query(new ZodValidationPipe(VatReportQuerySchema)) q: VatReportQuery) {
    return this.reports.vat303(tenantId, q.quarter);
  }
}
