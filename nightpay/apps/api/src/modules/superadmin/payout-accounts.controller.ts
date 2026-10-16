import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  PayoutAccountListQuerySchema,
  StepUpWithReasonSchema,
  UpdatePayoutAccountSchema,
  type PayoutAccountFull,
  type PayoutAccountListItem,
  type PayoutAccountListQuery,
  type StepUpWithReasonDto,
  type UpdatePayoutAccountDto,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SuperAdminPayoutAccountsService } from './payout-accounts.service';
import { SUPERADMIN_REVEAL_LIMIT, SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

/** Cuentas de cobro de las chicas de todos los locales (tapadas; verlas o cambiarlas, con 2FA). */
@Controller('superadmin/payout-accounts')
@UseGuards(SuperAdminGuard)
export class SuperAdminPayoutAccountsController {
  private readonly accounts: SuperAdminPayoutAccountsService;

  constructor(@Inject(SuperAdminPayoutAccountsService) accounts: SuperAdminPayoutAccountsService) {
    this.accounts = accounts;
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(PayoutAccountListQuerySchema)) query: PayoutAccountListQuery,
  ): Promise<PayoutAccountListItem[]> {
    return this.accounts.list(query);
  }

  @Post(':userId/reveal')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_REVEAL_LIMIT)
  async reveal(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<PayoutAccountFull> {
    return this.accounts.reveal(actor, userId, dto);
  }

  @Put(':userId')
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async update(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(UpdatePayoutAccountSchema)) dto: UpdatePayoutAccountDto,
  ): Promise<PayoutAccountListItem> {
    return this.accounts.update(actor, userId, dto);
  }
}
