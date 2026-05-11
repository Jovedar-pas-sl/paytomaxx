import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  VerifyPayoutSchema,
  type JwtPayload,
  type VerifyPayoutDto,
  type VerifyPayoutResult,
  type TreasuryStats,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { TreasuryService } from './treasury.service';

/**
 * Endpoints treasury (Phase 1A) — admin OWNER/MANAGER.
 * Path: /admin/treasury/*
 *
 * `verify-onchain` y `confirm-manual` operan sobre OperatorPayout existente.
 */
@Controller('admin/treasury')
@UseGuards(RolesGuard)
export class TreasuryController {
  private readonly treasury: TreasuryService;

  constructor(@Inject(TreasuryService) treasury: TreasuryService) {
    this.treasury = treasury;
  }

  @Get('stats')
  @Roles('OWNER', 'MANAGER')
  async stats(@Tenant() tenantId: string): Promise<TreasuryStats> {
    return this.treasury.getStats(tenantId);
  }

  @Get('exchange-rate')
  @Roles('OWNER', 'MANAGER')
  async exchangeRate() {
    return this.treasury.getExchangeRate();
  }

  @Post('payouts/:id/verify')
  @HttpCode(200)
  @Roles('OWNER')
  async verifyPayout(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(VerifyPayoutSchema)) dto: VerifyPayoutDto,
  ): Promise<VerifyPayoutResult> {
    return this.treasury.verifyPayout(tenantId, id, user.sub, dto);
  }

  @Post('payouts/:id/confirm-manual')
  @HttpCode(200)
  @Roles('OWNER')
  async confirmManual(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    return this.treasury.confirmManual(tenantId, id, user.sub);
  }

  /**
   * Dispara reconciliación bajo demanda (también corre vía cron nocturno).
   */
  @Post('reconcile')
  @HttpCode(200)
  @Roles('OWNER')
  async reconcile(@Tenant() tenantId: string) {
    return this.treasury.reconcilePending(tenantId);
  }
}
