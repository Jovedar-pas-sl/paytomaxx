import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { JwtPayload } from '@nightpay/contracts';
import { RefundsService } from './refunds.service';

const RefundBodySchema = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().max(500).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
type RefundBody = z.infer<typeof RefundBodySchema>;

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

  @Get(':id/refunds')
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async list(@Param('id') paymentId: string) {
    return this.refunds.listForPayment(paymentId);
  }
}
