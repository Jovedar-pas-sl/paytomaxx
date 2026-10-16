import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  CustomerSearchQuerySchema,
  ReasonOnlySchema,
  StepUpWithReasonSchema,
  type CustomerSearchQuery,
  type CustomerSearchResult,
  type CustomerWalletDetail,
  type ReasonOnlyDto,
  type RelinkResponse,
  type StepUpWithReasonDto,
} from '@nightpay/contracts';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { SuperAdminCustomersService } from './customers.service';
import { SUPERADMIN_SEARCH_LIMIT, SUPERADMIN_WRITE_LIMIT } from './rate-limits';
import { CurrentSuperAdmin, SuperAdminGuard, type SuperAdminActor } from './superadmin.guard';

/** Clientes con saldo de todos los locales. */
@Controller('superadmin/customers')
@UseGuards(SuperAdminGuard)
export class SuperAdminCustomersController {
  private readonly customers: SuperAdminCustomersService;

  constructor(@Inject(SuperAdminCustomersService) customers: SuperAdminCustomersService) {
    this.customers = customers;
  }

  @Get('search')
  @IpRateLimit(SUPERADMIN_SEARCH_LIMIT)
  async search(
    @Query(new ZodValidationPipe(CustomerSearchQuerySchema)) query: CustomerSearchQuery,
  ): Promise<CustomerSearchResult[]> {
    return this.customers.search(query.q);
  }

  @Get(':walletId')
  async detail(@Param('walletId', ParseUUIDPipe) walletId: string): Promise<CustomerWalletDetail> {
    return this.customers.detail(walletId);
  }

  @Post(':walletId/block')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async block(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(ReasonOnlySchema)) dto: ReasonOnlyDto,
  ): Promise<CustomerWalletDetail> {
    return this.customers.block(actor, walletId, dto);
  }

  @Post(':walletId/unblock')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async unblock(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<CustomerWalletDetail> {
    return this.customers.unblock(actor, walletId, dto);
  }

  @Post(':walletId/unlock-pin')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async unlockPin(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<CustomerWalletDetail> {
    return this.customers.unlockPin(actor, walletId, dto);
  }

  @Post(':walletId/relink')
  @HttpCode(200)
  @IpRateLimit(SUPERADMIN_WRITE_LIMIT)
  async relink(
    @CurrentSuperAdmin() actor: SuperAdminActor,
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(StepUpWithReasonSchema)) dto: StepUpWithReasonDto,
  ): Promise<RelinkResponse> {
    return this.customers.relink(actor, walletId, dto);
  }
}
