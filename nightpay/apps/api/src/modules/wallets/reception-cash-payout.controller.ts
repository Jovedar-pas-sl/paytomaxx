import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletChargesService } from './wallet-charges.service';

export const ReceptionCashSchema = z.object({
  card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  uid: z.string().min(8).max(64),
  pin: z.string().regex(/^\d{4}$/),
  expectedAmountCents: z.number().int().positive().max(99_999),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
}).strict();

@Controller('reception')
@UseGuards(RolesGuard)
export class ReceptionCashPayoutController {
  constructor(@Inject(WalletChargesService) private readonly charges: WalletChargesService) {}

  @Post('wallets/:id/payout')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'reception-payout' })
  payout(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) walletId: string,
    @Body(new ZodValidationPipe(ReceptionCashSchema)) body: z.infer<typeof ReceptionCashSchema>) {
    return this.charges.payoutAtReception({ userId: user.sub, role: user.role, tenantId: user.tenantId }, walletId, body);
  }
}
