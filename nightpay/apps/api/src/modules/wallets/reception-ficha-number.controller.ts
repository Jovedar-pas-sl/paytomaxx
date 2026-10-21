import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { type JwtPayload, type ReceptionDeskView } from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { WalletCardsService } from './wallet-cards.service';

export const FichaNumberSchema = z.object({
  card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  uid: z.string().min(8).max(64),
  printedNumber: z.string().regex(/^[0-9]{1,12}$/, 'Escribe entre 1 y 12 cifras del n\u00famero impreso'),
}).strict();

export const FichaNumberLookupSchema = z.object({ printedNumber: z.string().regex(/^[0-9]{1,12}$/) }).strict();

@Controller('reception/fichas')
@UseGuards(RolesGuard)
export class ReceptionFichaNumberController {
  constructor(@Inject(WalletCardsService) private readonly cards: WalletCardsService) {}

  @Post('lookup-number')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'reception-fichas-lookup-number' })
  lookupNumber(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(FichaNumberLookupSchema)) body: z.infer<typeof FichaNumberLookupSchema>): Promise<ReceptionDeskView> {
    return this.cards.deskByPrintedNumber({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body.printedNumber);
  }

  @Post('number')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'reception-fichas-number' })
  label(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(FichaNumberSchema)) body: z.infer<typeof FichaNumberSchema>) {
    return this.cards.labelStock({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }
}
