import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { JwtPayload } from '@nightpay/contracts';
import { madridDay } from '../../common/time/madrid';
import { RefundsService } from './refunds.service';

const RefundBodySchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
type RefundBody = z.infer<typeof RefundBodySchema>;

/** Fase 1C — devolución ya hecha en el portal de BBVA. */
const BankRefundBodySchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3, 'Explica el motivo (mínimo 3 letras)').max(500),
  bankReference: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Día de la devolución en el banco (YYYY-MM-DD). */
  refundedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD')
    .optional(),
  confirmDuplicate: z.boolean().optional(),
});
type BankRefundBody = z.infer<typeof BankRefundBodySchema>;

/** El dueño comprobó en la pasarela una devolución que quedó sin confirmar. */
export const ResolvePendingBodySchema = z.object({
  outcome: z.enum(['SUCCEEDED', 'FAILED']),
  note: z.string().trim().min(3, 'Explica qué viste en la pasarela (mínimo 3 letras)').max(500),
});
type ResolvePendingBody = z.infer<typeof ResolvePendingBodySchema>;

@Controller('payments')
@UseGuards(RolesGuard)
export class RefundsController {
  private readonly refunds: RefundsService;
  constructor(@Inject(RefundsService) refunds: RefundsService) {
    this.refunds = refunds;
  }

  @Post(':id/refunds')
  @HttpCode(201)
  @Roles('OWNER', 'MANAGER')
  async create(
    @Param('id') paymentId: string,
    @Body(new ZodValidationPipe(RefundBodySchema)) body: RefundBody,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.refunds.refund(
      {
        paymentId,
        amountCents: body.amountCents,
        reason: body.reason,
        totpCode: body.totpCode,
      },
      { userId: user.sub, role: user.role, tenantId: user.tenantId },
    );
  }

  /**
   * Apunta una devolución que el dueño ya hizo en el portal de BBVA: ajusta
   * el cobro y descuenta la parte de la chica. No mueve dinero.
   */
  @Post(':id/refunds/bank')
  @HttpCode(201)
  @Roles('OWNER')
  async registerBank(
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body(new ZodValidationPipe(BankRefundBodySchema)) body: BankRefundBody,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.refunds.registerBankRefund(
      {
        paymentId,
        amountCents: body.amountCents,
        reason: body.reason,
        bankReference: body.bankReference,
        refundedAt: refundedAtOf(body.refundedOn),
        confirmDuplicate: body.confirmDuplicate,
      },
      { userId: user.sub, role: user.role, tenantId: user.tenantId },
    );
  }

  /**
   * Devolución que quedó PENDIENTE porque la pasarela no confirmó (timeout,
   * error de red…): el dueño la mira en el portal y la marca hecha (se
   * descuenta del cobro y a la chica) o no hecha (se libera lo reservado).
   */
  @Post(':id/refunds/:refundId/resolve')
  @HttpCode(200)
  @Roles('OWNER')
  async resolvePending(
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @Body(new ZodValidationPipe(ResolvePendingBodySchema)) body: ResolvePendingBody,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.refunds.resolvePending(
      { paymentId, refundId, outcome: body.outcome, note: body.note },
      { userId: user.sub, role: user.role, tenantId: user.tenantId },
    );
  }

  @Get(':id/refunds')
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async list(@Param('id') paymentId: string) {
    return this.refunds.listForPayment(paymentId);
  }
}

/**
 * Día de la devolución → instante. Hoy (en Madrid) = ahora; un día anterior
 * = su mediodía UTC, que es el mismo día visto en hora de Madrid.
 */
function refundedAtOf(day: string | undefined): Date | undefined {
  if (!day) return undefined;
  const today = madridDay();
  if (day > today) throw new BadRequestException('La fecha de la devolución no puede ser futura');
  return day === today ? new Date() : new Date(`${day}T12:00:00Z`);
}
