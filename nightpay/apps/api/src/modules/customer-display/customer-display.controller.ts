import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, UseGuards } from '@nestjs/common';
import {
  CustomerDisplayCurrentSchema,
  CustomerDisplayFichaSchema,
  CustomerDisplayPairSchema,
  CustomerDisplayPinSchema,
  CustomerDisplayTipSchema,
  type CustomerDisplayCode,
  type CustomerDisplayCurrentDto,
  type CustomerDisplayFichaDto,
  type CustomerDisplayFichaResult,
  type CustomerDisplayPairDto,
  type CustomerDisplayPinDto,
  type CustomerDisplayTipDto,
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
 *   - GET  /v1/customer-display/screen → lo que enseña: importe, propina, QR y estado (sin datos personales).
 *   - POST /v1/customer-display/tip    → la propina que elige el cliente (0 = «Sin propina»).
 *   - POST /v1/customer-display/ficha  → su ficha (Web NFC de la tablet) paga el cobro activo; o pide el PIN.
 *   - POST /v1/customer-display/ficha/pin → con su PIN, tecleado en la tablet.
 *   - POST /v1/customer-display/unpair → desemparejarse.
 *  Todo, solo sobre el cobro activo de su camarero (su «key») y como él: las
 *  mismas comprobaciones que su móvil. La credencial no crea, no cancela y no devuelve nada.
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

  /** Sin saldo ni nombres. Con el tiempo real conectado, la tablet pregunta poco. */
  @Get('screen')
  @Public()
  @UseGuards(DisplayGuard)
  @IpRateLimit({ max: 240, windowSec: 60, scope: 'customer-display-screen', failOpen: true })
  screen(@CurrentDisplay() display: DisplaySession): Promise<CustomerScreenView> {
    return this.displays.screen(display);
  }

  /** La propina que elige el cliente: solo una de las que se ofrecen, en el cobro que enseña. */
  @Post('tip')
  @Public()
  @HttpCode(200)
  @UseGuards(DisplayGuard)
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'customer-display-tip' })
  setTip(
    @CurrentDisplay() display: DisplaySession,
    @Body(new ZodValidationPipe(CustomerDisplayTipSchema)) body: CustomerDisplayTipDto,
  ): Promise<CustomerScreenView> {
    return this.displays.setTip(display, body);
  }

  /** La ficha en la tablet: los mismos topes por IP que el pago con ficha del móvil del personal. */
  @Post('ficha')
  @Public()
  @HttpCode(200)
  @UseGuards(DisplayGuard)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-pin' })
  payWithFicha(
    @CurrentDisplay() display: DisplaySession,
    @Body(new ZodValidationPipe(CustomerDisplayFichaSchema)) body: CustomerDisplayFichaDto,
  ): Promise<CustomerDisplayFichaResult> {
    return this.displays.payWithFicha(display, body);
  }

  @Post('ficha/pin')
  @Public()
  @HttpCode(200)
  @UseGuards(DisplayGuard)
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'wallet-pin' })
  payWithFichaPin(
    @CurrentDisplay() display: DisplaySession,
    @Body(new ZodValidationPipe(CustomerDisplayPinSchema)) body: CustomerDisplayPinDto,
  ): Promise<CustomerDisplayFichaResult> {
    return this.displays.payWithFichaPin(display, body);
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
