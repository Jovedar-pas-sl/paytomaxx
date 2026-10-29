import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  ReleaseBankHoldSchema,
  type BankHoldList,
  type BankReleaseResult,
  type JwtPayload,
  type ReleaseBankHoldDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { BankHoldsService } from './bank-holds.service';
import { OperatorsService } from './operators.service';

/**
 * Ventas por datáfono sin cuadrar con el banco (H-1), en la ficha de la chica:
 *  - GET  /v1/admin/operators/:id/bank-holds  → lo retenido de esa persona (dueño y encargado).
 *  - POST /v1/admin/payments/:id/bank-release → el dueño lo libera con su 2FA (nunca la suya).
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class BankHoldsController {
  private readonly holds: BankHoldsService;
  private readonly operators: OperatorsService;

  constructor(@Inject(BankHoldsService) holds: BankHoldsService, @Inject(OperatorsService) operators: OperatorsService) {
    this.holds = holds;
    this.operators = operators;
  }

  @Get('operators/:id/bank-holds')
  @Roles('OWNER', 'MANAGER')
  async list(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BankHoldList> {
    // La chica (o el camarero) tiene que ser de este local (anti-IDOR).
    await this.operators.ensureBelongsToVenue(id, tenantId);
    return this.holds.listForOperator(tenantId, id, { userId: user.sub, role: user.role });
  }

  @Post('payments/:id/bank-release')
  @HttpCode(200)
  @Roles('OWNER')
  async release(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ReleaseBankHoldSchema)) dto: ReleaseBankHoldDto,
  ): Promise<BankReleaseResult> {
    return this.holds.release({ userId: user.sub, role: user.role, tenantId }, id, dto);
  }
}
