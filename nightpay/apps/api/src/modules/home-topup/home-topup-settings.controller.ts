import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Patch, Post, UseGuards } from '@nestjs/common';
import { UpdateHomeTopUpSchema, type HomeTopUpSettings, type JwtPayload, type UpdateHomeTopUpDto } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { HomeTopUpSettingsService, type HomeTopUpQueuePoster } from './home-topup-settings.service';

/**
 * Ajustes → Formas de cobro → «Cargar saldo desde casa» (solo el dueño, como
 * las demás formas de cobro):
 *  - GET   /v1/admin/venue/home-topup         → interruptor, enlace y su QR.
 *  - PATCH /v1/admin/venue/home-topup         → { enabled }.
 *  - POST  /v1/admin/venue/home-topup/rotate  → «Enlace nuevo».
 *  - PATCH /v1/admin/venue/home-topup/gifts   → «Regalos» { enabled } (apagado de serie).
 *  - GET   /v1/admin/venue/home-topup/queue   → el cartel de la cola de esta noche (B16).
 */
@Controller('admin/venue/home-topup')
@UseGuards(RolesGuard)
export class HomeTopUpSettingsController {
  constructor(@Inject(HomeTopUpSettingsService) private readonly settings: HomeTopUpSettingsService) {}

  @Get()
  @Roles('OWNER')
  async view(@CurrentUser() user: JwtPayload): Promise<HomeTopUpSettings> {
    return this.settings.view(user.tenantId);
  }

  @Patch()
  @Roles('OWNER')
  async update(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateHomeTopUpSchema)) dto: UpdateHomeTopUpDto,
  ): Promise<HomeTopUpSettings> {
    return this.settings.setEnabled({ userId: user.sub, email: user.email, tenantId: user.tenantId }, dto.enabled);
  }

  /** «Regalos» («Regala una noche»): { enabled }. */
  @Patch('gifts')
  @Roles('OWNER')
  async updateGifts(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateHomeTopUpSchema)) dto: UpdateHomeTopUpDto,
  ): Promise<HomeTopUpSettings> {
    return this.settings.setGifts({ userId: user.sub, email: user.email, tenantId: user.tenantId }, dto.enabled);
  }

  @Get('queue')
  @Roles('OWNER')
  async queue(@CurrentUser() user: JwtPayload): Promise<HomeTopUpQueuePoster> {
    const poster = await this.settings.queuePoster(user.tenantId);
    if (!poster) throw new NotFoundException({ message: 'Enciende «Cargar saldo desde casa» para imprimir el cartel.', code: 'HOME_TOPUP_OFF' });
    return poster;
  }

  @Post('rotate')
  @HttpCode(200)
  @Roles('OWNER')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'home-topup-rotate' })
  async rotate(@CurrentUser() user: JwtPayload): Promise<HomeTopUpSettings> {
    return this.settings.rotate({ userId: user.sub, email: user.email, tenantId: user.tenantId });
  }
}
