import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReverseConsumptionSchema, type JwtPayload, type ReverseConsumptionDto } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletsService } from './wallets.service';
import { blindWalletStats, blindsCash } from '../nights/blind-cash';
import { MoneyMapService } from '../money-map/money-map.service';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { WalletViewGuard } from './wallet-view.guard';

/**
 * Phase 1B — Wallets.
 *
 * Endpoints:
 *  - GET  /v1/wallets/public/:qrToken            (cliente — sin auth)
 *  - POST /v1/wallets/:id/consumptions/:cid/reverse (OWNER/MANAGER; el encargado,
 *    desde el umbral del local, con totpCode)
 *  - GET  /v1/wallets                            (OWNER/MANAGER — saldos abiertos)
 *  - GET  /v1/wallets/:id                        (OWNER/MANAGER)
 *  - GET  /v1/admin/wallets[/stats]              (OWNER/MANAGER — panel de saldos)
 *
 * El top-up flow (POST /payments con wallet:{create:true}) vive en PaymentsController
 * porque crea un Payment + dispara el flow de pasarela. Cobrar y devolver el
 * saldo: /v1/wallet-charges (WalletChargesController).
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
  @UseGuards(WalletViewGuard)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async publicView(@Param('qrToken') qrToken: string) {
    if (qrToken.length < 8 || qrToken.length > 100) {
      throw new BadRequestException('qrToken inválido');
    }
    return this.wallets.getPublicByToken(qrToken);
  }

  @Post(':id/consumptions/:consumptionId/reverse')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('cash')
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
      totpCode: dto.totpCode,
      reason: dto.reason,
    });
  }

  /**
   * Saldos abiertos del local, para el encargado o el dueño. Lleva el código
   * de cada cliente (con el código y su PIN se paga), su etiqueta y su saldo:
   * la chica y el camarero no la ven; encuentran el saldo por el código que
   * les dice el cliente o por su ficha (/v1/wallet-charges/lookup).
   */
  @Get()
  @Roles('MANAGER', 'OWNER')
  async listActive(
    @Tenant() tenantId: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 50)) : 50;
    return this.wallets.listForAdmin({
      tenantId,
      status: 'ACTIVE',
      limit: parsedLimit,
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
  private readonly moneyMap: MoneyMapService;

  constructor(@Inject(WalletsService) wallets: WalletsService, @Inject(MoneyMapService) moneyMap: MoneyMapService) {
    this.wallets = wallets;
    this.moneyMap = moneyMap;
  }

  /** Las cifras de «esta noche»: desde donde cuenta su Z, como el mapa del dinero en directo. */
  @Get('stats')
  @Roles('OWNER', 'MANAGER')
  async stats(@CurrentUser() user: JwtPayload) {
    const window = await this.moneyMap.currentWindow(user.tenantId);
    const stats = await this.wallets.getAdminStats(user.tenantId, window);
    // Cierre a ciegas: la encargada con la noche abierta, sin las recargas ni lo devuelto en efectivo.
    return blindsCash(user.role, window.open) ? blindWalletStats(stats) : stats;
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
