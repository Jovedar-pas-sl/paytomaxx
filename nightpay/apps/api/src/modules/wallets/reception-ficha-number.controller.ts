import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import {
  ReceptionNumberTopUpSchema,
  type JwtPayload,
  type ReceptionNumberTopUpDto,
  type ReceptionNumberTopUpResult,
  type ReceptionNumberView,
} from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRateLimit, UserRateLimitGuard } from '../../common/guards/user-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { FichaNumbersService } from './ficha-numbers.service';
import { WalletCardsService } from './wallet-cards.service';

export const FichaNumberSchema = z.object({
  card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  uid: z.string().min(8).max(64),
  printedNumber: z.string().regex(/^[0-9]{1,12}$/, 'Escribe entre 1 y 12 cifras del número impreso'),
}).strict();

export const FichaNumberLookupSchema = z.object({ printedNumber: z.string().regex(/^[0-9]{1,12}$/) }).strict();

/**
 * El número impreso de la ficha NFC en recepción:
 *  - POST /v1/reception/fichas/lookup-number → buscarla sin acercarla: un resumen sin el código ni el id del saldo.
 *  - POST /v1/reception/fichas/number-topup  → recargar en efectivo el saldo de esa ficha (no una nueva).
 *  - POST /v1/reception/fichas/number        → numerar la ficha recién preparada (con ella delante).
 * Buscar tiene tope por persona (además del de la IP) y queda en el registro.
 */
@Controller('reception/fichas')
@UseGuards(RolesGuard)
export class ReceptionFichaNumberController {
  constructor(
    @Inject(WalletCardsService) private readonly cards: WalletCardsService,
    @Inject(FichaNumbersService) private readonly numbers: FichaNumbersService,
  ) {}

  @Post('lookup-number')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'reception-fichas-lookup-number' })
  @UseGuards(UserRateLimitGuard)
  @UserRateLimit({ max: 20, windowSec: 60, scope: 'reception-fichas-lookup-number' })
  lookupNumber(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(FichaNumberLookupSchema)) body: z.infer<typeof FichaNumberLookupSchema>,
  ): Promise<ReceptionNumberView> {
    return this.numbers.lookup({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body.printedNumber);
  }

  @Post('number-topup')
  @HttpCode(201)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'reception-fichas-number-topup' })
  topUpByNumber(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ReceptionNumberTopUpSchema)) body: ReceptionNumberTopUpDto,
  ): Promise<ReceptionNumberTopUpResult> {
    return this.numbers.topUp({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }

  @Post('number')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'reception-fichas-number' })
  label(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(FichaNumberSchema)) body: z.infer<typeof FichaNumberSchema>) {
    return this.cards.labelStock({ userId: user.sub, role: user.role, tenantId: user.tenantId }, body);
  }
}
