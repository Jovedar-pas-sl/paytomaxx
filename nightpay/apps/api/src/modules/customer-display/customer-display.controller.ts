import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, UseGuards } from '@nestjs/common';
import {
  CustomerDisplayCurrentSchema,
  CustomerDisplayPairSchema,
  type CustomerDisplayCode,
  type CustomerDisplayCurrentDto,
  type CustomerDisplayPairDto,
  type CustomerDisplayPairResult,
  type CustomerDisplayStatus,
  type CustomerScreenView,
  type JwtPayload,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CustomerDisplayService, type DisplayOwner } from './customer-display.service';
import type { DisplaySession } from './display-auth';
import { CurrentDisplay, DisplayGuard } from './display.guard';

const ownerOf = (user: JwtPayload): DisplayOwner => ({ userId: user.sub, tenantId: user.tenantId });

/**
 * «Pantalla del cliente» (tablet de la barra que mira al cliente).
 *  App del personal (su sesión):
 *   - GET    /v1/customer-display              → ¿tengo pantalla emparejada? ¿hasta cuándo?
 *   - POST   /v1/customer-display/pairing-code → código corto (5 min) para la tablet.
 *   - DELETE /v1/customer-display              → desemparejarla.
 *   - PUT    /v1/customer-display/current      → el cobro que enseña (uno suyo).
 *   - POST   /v1/customer-display/current/clear → salió de ese cobro.
 *  Tablet (Authorization: Pantalla <credencial>):
 *   - POST /v1/customer-display/pair   → canjea el código por la credencial (con tope de intentos).
 *   - GET  /v1/customer-display/screen → lo que enseña: importe, QR y estado (sin datos personales).
 *   - POST /v1/customer-display/unpair → desemparejarse.
 *  La credencial de la tablet no sirve para nada más: no crea, no cancela, no devuelve.
 */
@Controller('customer-display')
export class CustomerDisplayController {
  private readonly displays: CustomerDisplayService;

  constructor(@Inject(CustomerDisplayService) displays: CustomerDisplayService) {
    this.displays = displays;
  }

  // ─── App del personal ──────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  status(@CurrentUser() user: JwtPayload): Promise<CustomerDisplayStatus> {
    return this.displays.status(ownerOf(user));
  }

  @Post('pairing-code')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'customer-display-code' })
  createCode(@CurrentUser() user: JwtPayload): Promise<CustomerDisplayCode> {
    return this.displays.createCode(ownerOf(user));
  }

  @Delete()
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  unpair(@CurrentUser() user: JwtPayload): Promise<{ ok: true }> {
    return this.displays.unpairByOwner(ownerOf(user));
  }

  @Put('current')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  show(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CustomerDisplayCurrentSchema)) body: CustomerDisplayCurrentDto,
  ): Promise<CustomerDisplayStatus> {
    return this.displays.show(ownerOf(user), body);
  }

  @Post('current/clear')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  clear(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CustomerDisplayCurrentSchema)) body: CustomerDisplayCurrentDto,
  ): Promise<{ ok: true }> {
    return this.displays.clear(ownerOf(user), body);
  }

  // ─── La tablet ─────────────────────────────────────────────────────

  /** Tope por IP: 10 intentos cada 5 minutos (el código caduca a los 5 y tiene 887 millones de combinaciones). */
  @Post('pair')
  @Public()
  @HttpCode(200)
  @IpRateLimit({ max: 10, windowSec: 300, scope: 'customer-display-pair' })
  pair(@Body(new ZodValidationPipe(CustomerDisplayPairSchema)) body: CustomerDisplayPairDto): Promise<CustomerDisplayPairResult> {
    return this.displays.pair(body.code);
  }

  /** Solo leer: sin saldo ni nombres. Con el tiempo real conectado, la tablet pregunta poco. */
  @Get('screen')
  @Public()
  @UseGuards(DisplayGuard)
  @IpRateLimit({ max: 240, windowSec: 60, scope: 'customer-display-screen', failOpen: true })
  screen(@CurrentDisplay() display: DisplaySession): Promise<CustomerScreenView> {
    return this.displays.screen(display);
  }

  @Post('unpair')
  @Public()
  @HttpCode(200)
  @UseGuards(DisplayGuard)
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'customer-display-unpair' })
  unpairDisplay(@CurrentDisplay() display: DisplaySession): Promise<{ ok: true }> {
    return this.displays.unpairByDisplay(display);
  }
}
