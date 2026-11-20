import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  CobroKindParamSchema,
  OwnCobrosQuerySchema,
  ownRefundedCents,
  type CobroDetail,
  type CobroDetailSensitive,
  type CobroKind,
  type JwtPayload,
  type OwnCobrosPage,
  type OwnCobrosQuery,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CobroDetailService } from './cobro-detail.service';
import { CobrosService } from './cobros.service';
import { MoneyMapService } from './money-map.service';

/** Solo los cobros creados por el usuario de la sesión, en su local. Sin filtros de identidad del cliente. */
@Controller('staff/me')
@UseGuards(RolesGuard)
export class OwnCobrosController {
  constructor(
    @Inject(CobrosService) private readonly cobros: CobrosService,
    @Inject(MoneyMapService) private readonly moneyMap: MoneyMapService,
    @Inject(CobroDetailService) private readonly details: CobroDetailService,
  ) {}

  /**
   * El detalle de uno de sus cobros: lo básico y «lo tuyo» (su comisión, su
   * propina, su parte de una invitación). De otra persona, 404. Nunca la parte
   * del local ni el reparto.
   */
  @Get('cobros/:kind/:id')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async detail(
    @CurrentUser() user: JwtPayload,
    @Param('kind', new ZodValidationPipe(CobroKindParamSchema)) kind: CobroKind,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CobroDetail> {
    return this.details.forStaff(user, kind, id);
  }

  /** Solo lo delicado de uno de sus cobros: sin la verificación vigente, 403 STEP_UP_REQUIRED. */
  @Get('cobros/:kind/:id/sensitive')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async sensitive(
    @CurrentUser() user: JwtPayload,
    @Param('kind', new ZodValidationPipe(CobroKindParamSchema)) kind: CobroKind,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CobroDetailSensitive> {
    return this.details.sensitiveFor(user, kind, id, 'STAFF');
  }

  @Get('cobros')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async list(@CurrentUser() user: JwtPayload, @Query(new ZodValidationPipe(OwnCobrosQuerySchema)) query: OwnCobrosQuery): Promise<OwnCobrosPage> {
    // Una detrás de otra (antes, a la vez): cada una es una transacción, y con
    // muchas peticiones juntas de la misma persona dos conexiones por petición
    // agotaban el pool (P2028, 500 en la prueba real).
    const page = await this.cobros.list(user.tenantId, {
      limit: query.limit,
      cursor: query.cursor,
      from: query.from,
      to: query.to,
      operatorId: user.sub,
      status: undefined,
    });
    // La noche (para «Esta noche» en la app), solo con la primera página y sin fechas.
    const night = query.cursor || query.from || query.to ? null : await this.moneyMap.currentWindow(user.tenantId);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        kind: r.kind, id: r.id, ref: r.ref, createdAt: r.createdAt, amountCents: r.amountCents,
        tipCents: r.tipCents, serviceFeeCents: r.serviceFeeCents ?? 0, status: r.status, methodLabel: r.methodLabel, via: r.via ?? null,
        service: r.service, isTopUp: r.isTopUp, invitedName: r.invited?.name ?? null, refundedCents: ownRefundedCents(r),
        paidTwice: r.paidTwice ?? null,
      })),
      ...(night ? { night: { from: night.from.toISOString(), open: night.open } } : {}),
    };
  }
}
