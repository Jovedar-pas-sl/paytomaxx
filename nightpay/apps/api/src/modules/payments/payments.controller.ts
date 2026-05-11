import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreatePaymentSchema,
  type CreatePaymentDto,
  type CreatedPaymentResponse,
  type PublicPaymentView,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../../common/decorators/idempotent.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { JwtPayload } from '@nightpay/contracts';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  private readonly payments: PaymentsService;
  constructor(@Inject(PaymentsService) payments: PaymentsService) {
    this.payments = payments;
  }

  /**
   * TPV crea un pago. Requiere AuthGuard (global) + role.
   * Idempotency-Key obligatoria — clave de las mutaciones financieras.
   */
  @Post()
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async create(
    @Tenant() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreatePaymentSchema)) dto: CreatePaymentDto,
  ): Promise<CreatedPaymentResponse> {
    return this.payments.create(tenantId, idempotencyKey, dto, {
      userId: user.sub,
      role: user.role,
    });
  }

  /**
   * Cancela un pago en estado CREATED|AWAITING_CAPTURE.
   * - OPERATOR solo cancela los suyos (createdByUserId === userId).
   * - OWNER/MANAGER cancelan cualquiera del venue.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'OPERATOR')
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ status: string }> {
    return this.payments.cancel(id, { userId: user.sub, role: user.role });
  }

  /**
   * Detalle interno (admin/manager) — pasa por Prisma middleware tenant filter.
   */
  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async findOne(@Param('id') id: string, @CurrentUser() _user: JwtPayload) {
    return this.payments.findById(id);
  }

  /**
   * Lookup público por QR token — el cliente lo escanea sin auth.
   * Sólo expone datos seguros (importe, venue, terminal).
   */
  @Public()
  @Get('public/:token')
  async getPublic(@Param('token') token: string): Promise<PublicPaymentView> {
    return this.payments.getByToken(token);
  }

  /**
   * Cliente confirma "voy a pagar" desde la pantalla del QR.
   * Mueve FSM a AUTHORIZING y dispara la pasarela.
   * Publico — la seguridad viene del qrToken unico.
   */
  @Public()
  @Post('public/:token/start-authorization')
  @HttpCode(202)
  async startAuthorization(
    @Param('token') token: string,
  ): Promise<{ status: string; providerTxId?: string }> {
    return this.payments.startAuthorization(token);
  }
}
