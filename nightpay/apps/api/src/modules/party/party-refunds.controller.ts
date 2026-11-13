import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  PartyRefundListQuerySchema,
  madridDay,
  type JwtPayload,
  type PartyRefundList,
  type PartyRefundListQuery,
  type PartyRefundRow,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PartyEditionGuard } from './party-edition.guard';
import { refundSepaFileName } from './party-refund-sepa';
import { PartyRefundsService } from './party-refunds.service';

/**
 * Devoluciones de «Lo que sobra» en el panel del organizador (OxioParty; con
 * EDITION=club, 404). Solo el dueño y el encargado.
 *  - GET  /v1/admin/party/refunds?status=&method=      la lista (las 300 más recientes) y los totales
 *  - POST /v1/admin/party/refunds/:id/done             «Hecha»: la tarjeta ya devuelta en el banco o la transferencia enviada
 *  - POST /v1/admin/party/refunds/:id/cancel           anularla (el saldo vuelve a poder gastarse)
 *  - GET  /v1/admin/party/refunds/transferencias.csv   las transferencias pendientes para el banco
 *  - GET  /v1/admin/party/refunds/transferencias.sepa  las mismas en un fichero SEPA (pain.001.001.03) para subirlas de una vez;
 *                                                      deudor, la cuenta del local (sin ella, 409 NO_DEBTOR_IBAN)
 * «Hecha», anular y el fichero SEPA quedan en el registro.
 */
@Controller('admin/party')
@UseGuards(PartyEditionGuard, RolesGuard)
export class PartyRefundsController {
  constructor(@Inject(PartyRefundsService) private readonly refunds: PartyRefundsService) {}

  @Get('refunds')
  @Roles('OWNER', 'MANAGER')
  list(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(PartyRefundListQuerySchema)) query: PartyRefundListQuery,
  ): Promise<PartyRefundList> {
    return this.refunds.list(user.tenantId, query);
  }

  @Get('refunds/transferencias.csv')
  @Roles('OWNER', 'MANAGER')
  async transfers(@CurrentUser() user: JwtPayload, @Res() res: FastifyReply): Promise<void> {
    const csv = await this.refunds.transfersCsv(user.tenantId);
    res
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="transferencias-pendientes-${madridDay()}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(csv);
  }

  @Get('refunds/transferencias.sepa')
  @Roles('OWNER', 'MANAGER')
  async transfersSepa(@CurrentUser() user: JwtPayload, @Res() res: FastifyReply): Promise<void> {
    const file = await this.refunds.transfersSepa({ userId: user.sub, role: user.role, tenantId: user.tenantId, email: user.email });
    res
      .status(200)
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${refundSepaFileName(madridDay())}"`)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.xml);
  }

  @Post('refunds/:id/done')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  done(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<PartyRefundRow> {
    return this.refunds.markDone({ userId: user.sub, role: user.role, tenantId: user.tenantId, email: user.email }, id);
  }

  @Post('refunds/:id/cancel')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  cancel(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<PartyRefundRow> {
    return this.refunds.cancel({ userId: user.sub, role: user.role, tenantId: user.tenantId, email: user.email }, id);
  }
}
