import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ConsumeWalletSchema,
  RefundWalletSchema,
  ReverseConsumptionSchema,
  type ConsumeWalletDto,
  type ConsumeWalletResult,
  type JwtPayload,
  type RefundWalletDto,
  type RefundWalletResult,
  type ReverseConsumptionDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletsService } from './wallets.service';

/**
 * Phase 1B — Wallets.
 *
 * Endpoints:
 *  - GET  /v1/wallets/public/:qrToken            (cliente — sin auth)
 *  - POST /v1/wallets/:id/consume                (OPERATOR/MANAGER/WAITER/OWNER)
 *  - POST /v1/wallets/:id/refund                 (OWNER)
 *  - POST /v1/wallets/:id/consumptions/:cid/reverse (OWNER/MANAGER)
 *  - GET  /v1/admin/wallets/stats                (admin — vía AdminController)
 *
 * El top-up flow (POST /payments con wallet:{create:true}) vive en PaymentsController
 * porque crea un Payment + dispara el flow de pasarela.
 */
@Controller('wallets')
@UseGuards(RolesGuard)
export class WalletsController {
  private readonly wallets: WalletsService;

  constructor(@Inject(WalletsService) wallets: WalletsService) {
    this.wallets = wallets;
  }

  /**
   * Vista pública: cliente escanea su QR y ve balance + consumos. Sin auth
   * porque el qrToken ES la cred. Token corto y único por wallet.
   */
  @Public()
  @Get('public/:qrToken')
  async publicView(@Param('qrToken') qrToken: string) {
    if (qrToken.length < 8 || qrToken.length > 100) {
      throw new BadRequestException('qrToken inválido');
    }
    return this.wallets.getPublicByToken(qrToken);
  }

  @Post(':id/consume')
  @HttpCode(200)
  @Roles('OPERATOR', 'MANAGER', 'WAITER', 'OWNER')
  async consume(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) walletId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(ConsumeWalletSchema)) dto: ConsumeWalletDto,
  ): Promise<ConsumeWalletResult> {
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new BadRequestException(
        'Header Idempotency-Key obligatorio (>=8 chars) para evitar doble-cobro',
      );
    }
    return this.wallets.consume({
      tenantId,
      walletId,
      providedByUserId: user.sub,
      idempotencyKey,
      dto,
    });
  }

  @Post(':id/refund')
  @HttpCode(200)
  @Roles('OWNER')
  async refund(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) walletId: string,
    @Body(new ZodValidationPipe(RefundWalletSchema)) dto: RefundWalletDto,
  ): Promise<RefundWalletResult> {
    return this.wallets.refund({
      tenantId,
      walletId,
      actorUserId: user.sub,
      dto,
    });
  }

  @Post(':id/consumptions/:consumptionId/reverse')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  async reverseConsumption(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) walletId: string,
    @Param('consumptionId', new ParseUUIDPipe()) consumptionId: string,
    @Body(new ZodValidationPipe(ReverseConsumptionSchema)) dto: ReverseConsumptionDto,
  ): Promise<{ refundedCents: number; newBalanceCents: number }> {
    return this.wallets.reverseConsumption({
      tenantId,
      walletId,
      consumptionId,
      actorUserId: user.sub,
      reason: dto.reason,
    });
  }

  @Get(':id')
  @Roles('OWNER', 'MANAGER')
  async getWallet(
    @Tenant() tenantId: string,
    @Param('id', new ParseUUIDPipe()) walletId: string,
  ) {
    return this.wallets.getWalletView({ tenantId, walletId });
  }
}

/** Endpoints admin para el WalletsPanel del dashboard. */
@Controller('admin/wallets')
@UseGuards(RolesGuard)
export class AdminWalletsController {
  private readonly wallets: WalletsService;

  constructor(@Inject(WalletsService) wallets: WalletsService) {
    this.wallets = wallets;
  }

  @Get('stats')
  @Roles('OWNER', 'MANAGER')
  async stats(@Tenant() tenantId: string) {
    return this.wallets.getAdminStats(tenantId);
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(
    @Tenant() tenantId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const validStatuses = ['ACTIVE', 'EXPIRED', 'REFUNDED', 'DEPLETED'] as const;
    type ValidStatus = (typeof validStatuses)[number];
    const filterStatus: ValidStatus | undefined = validStatuses.includes(status as ValidStatus)
      ? (status as ValidStatus)
      : undefined;
    const parsedLimit = limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50;
    return this.wallets.listForAdmin({
      tenantId,
      status: filterStatus,
      limit: parsedLimit,
    });
  }
}
