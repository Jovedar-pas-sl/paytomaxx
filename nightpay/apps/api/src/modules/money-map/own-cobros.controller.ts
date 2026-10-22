import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { OwnCobrosQuerySchema, ownRefundedCents, type JwtPayload, type OwnCobrosPage, type OwnCobrosQuery } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CobrosService } from './cobros.service';
import { MoneyMapService } from './money-map.service';

/** Solo los cobros creados por el usuario de la sesión, en su local. Sin filtros de identidad del cliente. */
@Controller('staff/me')
@UseGuards(RolesGuard)
export class OwnCobrosController {
  constructor(
    @Inject(CobrosService) private readonly cobros: CobrosService,
    @Inject(MoneyMapService) private readonly moneyMap: MoneyMapService,
  ) {}

  @Get('cobros')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async list(@CurrentUser() user: JwtPayload, @Query(new ZodValidationPipe(OwnCobrosQuerySchema)) query: OwnCobrosQuery): Promise<OwnCobrosPage> {
    const [page, night] = await Promise.all([
      this.cobros.list(user.tenantId, { limit: query.limit, cursor: query.cursor, operatorId: user.sub }),
      // La noche (para «Esta noche» en la app), solo con la primera página.
      query.cursor ? Promise.resolve(null) : this.moneyMap.currentWindow(user.tenantId),
    ]);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        kind: r.kind, id: r.id, ref: r.ref, createdAt: r.createdAt, amountCents: r.amountCents,
        tipCents: r.tipCents, status: r.status, methodLabel: r.methodLabel, via: r.via ?? null,
        service: r.service, isTopUp: r.isTopUp, invitedName: r.invited?.name ?? null, refundedCents: ownRefundedCents(r),
      })),
      ...(night ? { night: { from: night.from.toISOString(), open: night.open } } : {}),
    };
  }
}
