import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  CloseNightSchema,
  NightCashCountSchema,
  OpenNightSchema,
  type CloseNightDto,
  type JwtPayload,
  type NightCashCountDto,
  type NightCashCountResult,
  type NightCloseCheck,
  type OpenNightDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { blindCloseCheck, blindNightView, blindsCash } from './blind-cash';
import { NightsService, type MyNight, type NightListItem, type NightView } from './nights.service';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';

/**
 * Noche del local (Fase 1D).
 *  - GET  /v1/nights/current     → noche abierta con su Z en vivo y lo pendiente.
 *  - GET  /v1/nights/current/close-check → los pasos para cerrarla (cierre-noche).
 *    A la encargada, el efectivo a ciegas: ni el fondo, ni lo que se movió, ni lo esperado.
 *  - POST /v1/nights/current/cash-count → «Ver si cuadra» a ciegas: si cuadra o la diferencia.
 *  - POST /v1/nights/open        → abrir (una sola abierta por local), con el fondo de caja.
 *  - POST /v1/nights/:id/close   → cerrar: pasos, arqueo de caja y Z congelado.
 *    409 NIGHT_CLOSE_BLOCKED / NIGHT_CLOSE_NEEDS_ACK con los pasos (a la encargada, sin la diferencia);
 *    409 NIGHT_CLOSE_COUNT_FIRST si la encargada cierra contando sin «Ver si cuadra» antes.
 *  - GET  /v1/nights             → últimas noches.
 *  - GET  /v1/nights/:id         → una noche con su Z.
 *  - GET  /v1/nights/mine        → la noche en curso de la chica que llama.
 */
@Controller('nights')
@UseGuards(RolesGuard)
export class NightsController {
  private readonly nights: NightsService;

  constructor(@Inject(NightsService) nights: NightsService) {
    this.nights = nights;
  }

  @Get('current')
  @Roles('OWNER', 'MANAGER')
  async current(@CurrentUser() user: JwtPayload): Promise<{ night: NightView | null }> {
    const night = await this.nights.current(user.tenantId, user.role);
    return { night: night && forRole(user, night) };
  }

  @Get('current/close-check')
  @Roles('OWNER', 'MANAGER')
  async closeCheck(@CurrentUser() user: JwtPayload): Promise<NightCloseCheck> {
    const check = await this.nights.closeCheck(user.tenantId);
    // Cierre a ciegas: la noche de close-check siempre está abierta.
    return blindsCash(user.role, true) ? blindCloseCheck(check) : check;
  }

  @Post('current/cash-count')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('closeNight')
  async cashCount(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(NightCashCountSchema)) body: NightCashCountDto,
  ): Promise<NightCashCountResult> {
    return this.nights.cashCount(user.tenantId, user.sub, body);
  }

  @Get('mine')
  @Roles('OPERATOR')
  async mine(@CurrentUser() user: JwtPayload): Promise<MyNight> {
    return this.nights.mine(user.tenantId, user.sub);
  }

  @Post('open')
  @HttpCode(201)
  @Roles('OWNER', 'MANAGER')
  async open(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(OpenNightSchema)) body: OpenNightDto,
  ): Promise<NightView> {
    return forRole(user, await this.nights.open(user.tenantId, user.sub, body.openingFloatCents, user.role));
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('closeNight')
  async close(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(CloseNightSchema)) body: CloseNightDto,
  ): Promise<NightView> {
    return this.nights.close(user.tenantId, { userId: user.sub, role: user.role }, id, body);
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@CurrentUser() user: JwtPayload): Promise<NightListItem[]> {
    return this.nights.list(user.tenantId);
  }

  @Get(':id')
  @Roles('OWNER', 'MANAGER')
  async get(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<NightView> {
    return forRole(user, await this.nights.get(user.tenantId, id, user.role));
  }
}

/** Cierre a ciegas: la encargada, con la noche abierta, sin las cifras del efectivo. */
function forRole(user: JwtPayload, night: NightView): NightView {
  return blindsCash(user.role, night.closedAt === null) ? blindNightView(night) : night;
}
