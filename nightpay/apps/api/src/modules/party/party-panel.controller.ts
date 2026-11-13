import { Controller, Get, Inject, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  PartyLiveQuerySchema,
  PartySettlementQuerySchema,
  type JwtPayload,
  type PartyCashDesk,
  type PartyLive,
  type PartyLiveQuery,
  type PartySettlement,
  type PartySettlementQuery,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PartyEditionGuard } from './party-edition.guard';
import { PartyPanelService } from './party-panel.service';
import { partySettlementCsv, partySettlementFileName } from './party-settlement-csv';

/**
 * El panel del organizador de OxioParty (con EDITION=club, 404):
 *  - GET /v1/party/live?scope=night|event&night=AAAA-MM-DD&idleMin=15
 *      en directo (dueño y encargado): cargado, vendido, lo que queda en las
 *      pulseras, ventas por hora, casetas, taquillas y avisos.
 *  - GET /v1/party/cash-desk/me
 *      el efectivo de la caja de quien lo pide en la noche de ahora (la taquilla del personal).
 *  - GET /v1/party/settlement?from=AAAA-MM-DD&to=AAAA-MM-DD  (sin fechas: la fiesta entera)
 *  - GET /v1/party/settlement/sepa   transferencias para el banco (pain.001.001.03; queda en el registro).
 *      Ya descargado con las mismas noches: 409 ALREADY_EXPORTED (cuándo y quién), salvo `?again=1`.
 *  - GET /v1/party/settlement/csv
 *      la liquidación por caseta: dueño y encargado. Descargar no mueve dinero
 *      (lo hace el banco con su firma), como los demás CSV del panel: sin 2FA.
 */
@Controller('party')
@UseGuards(PartyEditionGuard, RolesGuard)
export class PartyPanelController {
  constructor(@Inject(PartyPanelService) private readonly panel: PartyPanelService) {}

  @Get('live')
  @Roles('OWNER', 'MANAGER')
  live(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(PartyLiveQuerySchema)) q: PartyLiveQuery,
  ): Promise<PartyLive> {
    return this.panel.live(user.tenantId, q);
  }

  @Get('cash-desk/me')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  cashDesk(@CurrentUser() user: JwtPayload): Promise<PartyCashDesk> {
    return this.panel.cashDesk(user.tenantId, user.sub);
  }

  @Get('settlement')
  @Roles('OWNER', 'MANAGER')
  settlement(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(PartySettlementQuerySchema)) q: PartySettlementQuery,
  ): Promise<PartySettlement> {
    return this.panel.settlement(user.tenantId, q);
  }

  @Get('settlement/sepa')
  @Roles('OWNER', 'MANAGER')
  async sepa(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(PartySettlementQuerySchema)) q: PartySettlementQuery,
    @Res() res: FastifyReply,
    @Query('again') again?: string,
  ): Promise<void> {
    const file = await this.panel.sepa(user, q, new Date(), { again: again === '1' });
    res
      .status(200)
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${partySettlementFileName(file.settlement, 'xml')}"`)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.xml);
  }

  @Get('settlement/csv')
  @Roles('OWNER', 'MANAGER')
  async csv(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(PartySettlementQuerySchema)) q: PartySettlementQuery,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const settlement = await this.panel.settlement(user.tenantId, q);
    res
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${partySettlementFileName(settlement, 'csv')}"`)
      .header('Cache-Control', 'no-store')
      .send(partySettlementCsv(settlement));
  }
}
