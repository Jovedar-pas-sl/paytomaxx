import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import {
  AuditListQuerySchema,
  type AuditEventPage,
  type AuditListQuery,
  type SuperAdminOverview,
} from '@nightpay/contracts';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SuperAdminAuditLogService } from './audit-log.service';
import { SuperAdminOverviewService } from './overview.service';
import { SuperAdminGuard } from './superadmin.guard';

/** Vista general y registro de la consola del super-admin. */
@Controller('superadmin')
@UseGuards(SuperAdminGuard)
export class SuperAdminOverviewController {
  private readonly overviewService: SuperAdminOverviewService;
  private readonly auditLog: SuperAdminAuditLogService;

  constructor(
    @Inject(SuperAdminOverviewService) overviewService: SuperAdminOverviewService,
    @Inject(SuperAdminAuditLogService) auditLog: SuperAdminAuditLogService,
  ) {
    this.overviewService = overviewService;
    this.auditLog = auditLog;
  }

  @Get('overview')
  async overview(): Promise<SuperAdminOverview> {
    return this.overviewService.overview();
  }

  @Get('audit')
  async audit(@Query(new ZodValidationPipe(AuditListQuerySchema)) query: AuditListQuery): Promise<AuditEventPage> {
    return this.auditLog.list(query);
  }
}
