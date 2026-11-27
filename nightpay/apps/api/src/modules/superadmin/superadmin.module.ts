import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IncidentsService } from '../incidents/incidents.service';
import { TelegramService } from '../incidents/telegram.service';
import { OperatorsModule } from '../operators/operators.module';
import { OxioPaySettlementsModule } from '../oxiopay-settlements/oxiopay-settlements.module';
import { WalletsModule } from '../wallets/wallets.module';
import { SuperAdminAuditLogService } from './audit-log.service';
import { SuperAdminBusinessesController } from './businesses.controller';
import { SuperAdminBusinessesService } from './businesses.service';
import { SuperAdminCustomersController } from './customers.controller';
import { SuperAdminCustomersService } from './customers.service';
import { SuperAdminOverviewController } from './overview.controller';
import { SuperAdminOverviewService } from './overview.service';
import { SuperAdminPartnersController } from './partners.controller';
import { SuperAdminPartnersService } from './partners.service';
import { SuperAdminPayoutAccountsController } from './payout-accounts.controller';
import { SuperAdminPayoutAccountsService } from './payout-accounts.service';
import { SuperAdminSettlementsController } from './settlements.controller';
import { SuperAdminSettlementsService } from './settlements.service';
import { SuperAdminStaffController } from './staff.controller';
import { SuperAdminStaffService } from './staff.service';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import { SuperAdminGuard } from './superadmin.guard';
import { SuperAdminVenuesController } from './venues.controller';
import { SuperAdminVenuesService } from './venues.service';
import { SuperAdminYavinController } from './yavin-venue.controller';
import { SuperAdminYavinService } from './yavin-venue.service';

/**
 * Consola del super-admin: /v1/superadmin/* (ver docs/SUPERADMIN.md).
 * IncidentsService se instancia aquí (sin el monitor de copias, que no es de
 * ningún local) para contar las incidencias de cada local en la vista general.
 */
@Module({
  imports: [AuthModule, OperatorsModule, WalletsModule, OxioPaySettlementsModule],
  controllers: [
    SuperAdminOverviewController,
    SuperAdminBusinessesController,
    SuperAdminVenuesController,
    // Yavin en un local (solo con YAVIN_ENABLED).
    SuperAdminYavinController,
    SuperAdminStaffController,
    SuperAdminPayoutAccountsController,
    SuperAdminCustomersController,
    SuperAdminSettlementsController,
    SuperAdminPartnersController,
  ],
  providers: [
    SuperAdminGuard,
    SuperAdminAuditService,
    SuperAdminStepUpService,
    SuperAdminOverviewService,
    SuperAdminBusinessesService,
    SuperAdminVenuesService,
    SuperAdminYavinService,
    SuperAdminStaffService,
    SuperAdminPayoutAccountsService,
    SuperAdminCustomersService,
    SuperAdminAuditLogService,
    SuperAdminSettlementsService,
    SuperAdminPartnersService,
    TelegramService,
    IncidentsService,
  ],
})
export class SuperAdminModule {}
