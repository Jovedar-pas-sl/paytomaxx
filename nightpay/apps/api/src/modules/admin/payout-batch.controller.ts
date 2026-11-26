import { PAYOUT_BATCH_KEY_RE, CreatePayoutBatchSchema, type CreatePayoutBatchDto, type JwtPayload, type PayoutBatchResult } from '@nightpay/contracts';
import { BadRequestException, Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../../common/decorators/idempotent.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRateLimit, UserRateLimitGuard } from '../../common/guards/user-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { PayoutBatchService } from './payout-batch.service';

/**
 * «Pagar» a varias a la vez desde el panel: el dueño (o el encargado que paga
 * directo) marca a varias personas y apunta sus pagos con UN segundo factor.
 * Mismas puertas que el pago de una en una (rol y permiso «pagos»); la clave
 * de la petición es obligatoria. Siempre 200: cada persona lleva su resultado.
 */
@Controller('admin/payout-batches')
@UseGuards(RolesGuard, StaffPermissionGuard, UserRateLimitGuard)
export class PayoutBatchController {
  private readonly batches: PayoutBatchService;

  constructor(@Inject(PayoutBatchService) batches: PayoutBatchService) {
    this.batches = batches;
  }

  @Post()
  @Roles('OWNER', 'MANAGER')
  @RequiresPermission('payouts')
  @UserRateLimit({ max: 10, windowSec: 60, scope: 'payout-batch' })
  @HttpCode(200)
  async create(
    @Tenant() tenantId: string,
    @CurrentUser() user: JwtPayload,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(CreatePayoutBatchSchema)) dto: CreatePayoutBatchDto,
  ): Promise<PayoutBatchResult> {
    // Más estrecha que la de otras rutas (sin «_», hasta 64): va dentro de la
    // acción de la prueba de la llave y de la clave de cada pago.
    if (!PAYOUT_BATCH_KEY_RE.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key (must be 8-64 chars [A-Za-z0-9-])');
    }
    return this.batches.pay({ userId: user.sub, role: user.role, tenantId }, idempotencyKey, dto);
  }
}
