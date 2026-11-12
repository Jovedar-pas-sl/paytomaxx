import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Put, UseGuards } from '@nestjs/common';
import {
  SaveBtcpaySettingsSchema,
  TestBtcpaySettingsSchema,
  UpdateBtcpayModeSchema,
  type BtcpaySettingsView,
  type BtcpayTestResult,
  type JwtPayload,
  type SaveBtcpaySettingsDto,
  type TestBtcpaySettingsDto,
  type UpdateBtcpayModeDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { BtcpayEnabledGuard } from './btcpay-flag';
import { BtcpayStoreService } from './btcpay-store.service';

/**
 * Ajustes → Formas de cobro → «Bitcoin (BTCPay)». Solo el dueño; guardar o
 * cambiar los datos pide su 2FA. La clave de API y el secreto del aviso no
 * salen nunca: el GET solo dice cómo termina la clave.
 *  - GET   /v1/admin/venue/btcpay        lo guardado
 *  - PUT   /v1/admin/venue/btcpay        guardar (prueba la conexión, registra el aviso en BTCPay)
 *  - PATCH /v1/admin/venue/btcpay        encender/apagar y para qué se usa
 *  - POST  /v1/admin/venue/btcpay/test   «Probar conexión»
 */
@Controller('admin/venue/btcpay')
@UseGuards(BtcpayEnabledGuard, RolesGuard)
@Roles('OWNER')
export class BtcpaySettingsController {
  constructor(@Inject(BtcpayStoreService) private readonly stores: BtcpayStoreService) {}

  @Get()
  view(@CurrentUser() user: JwtPayload): Promise<BtcpaySettingsView> {
    return this.stores.view(user.tenantId);
  }

  @Put()
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'btcpay-save' })
  save(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(SaveBtcpaySettingsSchema)) dto: SaveBtcpaySettingsDto,
  ): Promise<BtcpaySettingsView> {
    return this.stores.save(user, dto);
  }

  @Patch()
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'btcpay-mode' })
  updateMode(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateBtcpayModeSchema)) dto: UpdateBtcpayModeDto,
  ): Promise<BtcpaySettingsView> {
    return this.stores.updateMode(user, dto);
  }

  @Post('test')
  @HttpCode(200)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'btcpay-test' })
  test(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(TestBtcpaySettingsSchema)) dto: TestBtcpaySettingsDto,
  ): Promise<BtcpayTestResult> {
    return this.stores.test(user.tenantId, dto);
  }
}
