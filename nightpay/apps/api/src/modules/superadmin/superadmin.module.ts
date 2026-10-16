import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IncidentsService } from '../incidents/incidents.service';
import { OperatorsModule } from '../operators/operators.module';
import { WalletsModule } from '../wallets/wallets.module';
import { SuperAdminAuditLogService } from './audit-log.service';
import { SuperAdminBusinessesController } from './businesses.controller';
import { SuperAdminBusinessesService } from './businesses.service';
import { SuperAdminCustomersController } from './customers.controller';
import { SuperAdminCustomersService } from './customers.service';
import { SuperAdminOverviewController } from './overview.controller';
import { SuperAdminOverviewService } from './overview.service';
import { SuperAdminPayoutAccountsController } from './payout-accounts.controller';
import { SuperAdminPayoutAccountsService } from './payout-accounts.service';
import { SuperAdminStaffController } from './staff.controller';
import { SuperAdminStaffService } from './staff.service';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import { SuperAdminGuard } from './superadmin.guard';
import { SuperAdminVenuesController } from './venues.controller';
import { SuperAdminVenuesService } from './venues.service';

/**
 * Consola del super-admin: /v1/superadmin/* (ver docs/SUPERADMIN.md).
 * IncidentsService se instancia aquí (sin el monitor de copias, que no es de
 * ningún local) para contar las incidencias de cada local en la vista general.
 */
@Module({
  imports: [AuthModule, OperatorsModule, WalletsModule],
  controllers: [
    SuperAdminOverviewController,
    SuperAdminBusinessesController,
    SuperAdminVenuesController,
    SuperAdminStaffController,
    SuperAdminPayoutAccountsController,
    SuperAdminCustomersController,
  ],
  providers: [
    SuperAdminGuard,
    SuperAdminAuditService,
    SuperAdminStepUpService,
    SuperAdminOverviewService,
    SuperAdminBusinessesService,
    SuperAdminVenuesService,
    SuperAdminStaffService,
    SuperAdminPayoutAccountsService,
    SuperAdminCustomersService,
    SuperAdminAuditLogService,
    IncidentsService,
  ],
})
export class SuperAdminModule {}
