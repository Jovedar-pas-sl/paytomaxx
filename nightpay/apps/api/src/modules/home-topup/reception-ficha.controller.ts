import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import {
  GiveFichaSchema,
  ReplaceLostFichaSchema,
  type GiveFichaDto,
  type GivenFicha,
  type JwtPayload,
  type ReplaceLostFichaDto,
  type ReplacedFicha,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ReceptionFichaService } from './reception-ficha.service';

/**
 * POST /v1/reception/fichas/saldo → dar ficha a un saldo que aún no tiene (el
 * cargado desde casa): el saldo (buscado antes con POST /v1/reception/desk,
 * por su código o el de su QR), la ficha acercada y la prueba del cliente (la
 * de su QR o su PIN). Los mismos roles que la recepción exprés; quién carga
 * saldos lo mira el servicio (assertCanTopUp).
 */
@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionFichaController {
  constructor(@Inject(ReceptionFichaService) private readonly fichas: ReceptionFichaService) {}

  @Post('fichas/saldo')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-ficha-saldo' })
  async give(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(GiveFichaSchema)) body: GiveFichaDto,
  ): Promise<GivenFicha> {
    return this.fichas.give({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }

  /**
   * «Ficha perdida» (B6): ficha nueva para un saldo que ya tenía, buscado por
   * su QR, su código o el número de su ficha, y con su PIN (el encargado, sin
   * él). La vieja deja de pagar y la nueva se cobra del saldo, en la misma
   * operación.
   */
  @Post('fichas/replace-lost')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'reception-ficha-lost' })
  async replaceLost(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ReplaceLostFichaSchema)) body: ReplaceLostFichaDto,
  ): Promise<ReplacedFicha> {
    return this.fichas.replaceLost({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }
}
