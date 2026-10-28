import { Controller, Get, Inject, Param, ParseUUIDPipe, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { OwnerSettlementNotice, OwnerSettlementPage, SettlementDetail } from '@nightpay/contracts';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';
import { sendSettlementCsv, sendSettlementDocument } from './settlement-responses';

/**
 * «Liquidaciones OxioPay» en el panel del dueño (solo lectura): las de SU
 * local (el de la sesión; RLS de la base y el local explícito), la cuenta de
 * OxioPay para la transferencia, el documento para imprimir / PDF y el CSV.
 * Solo el dueño: ni el encargado ni el personal.
 *   GET /v1/admin/oxiopay-settlements              lista, cuenta de OxioPay y lo pendiente
 *   GET /v1/admin/oxiopay-settlements/notice       las que llevan más de 7 días sin pagar (aviso del panel)
 *   GET /v1/admin/oxiopay-settlements/:id          ficha con el desglose
 *   GET /v1/admin/oxiopay-settlements/:id/document página para imprimir o guardar como PDF
 *   GET /v1/admin/oxiopay-settlements/:id/csv      CSV
 */
@Controller('admin/oxiopay-settlements')
@UseGuards(RolesGuard)
@Roles('OWNER')
export class OwnerOxioPaySettlementsController {
  private readonly settlements: OxioPaySettlementsService;

  constructor(@Inject(OxioPaySettlementsService) settlements: OxioPaySettlementsService) {
    this.settlements = settlements;
  }

  @Get()
  async list(@Tenant() tenantId: string): Promise<OwnerSettlementPage> {
    return this.settlements.listForOwner(tenantId);
  }

  @Get('notice')
  async notice(@Tenant() tenantId: string): Promise<OwnerSettlementNotice> {
    return this.settlements.noticeForOwner(tenantId);
  }

  @Get(':id')
  async detail(@Tenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string): Promise<SettlementDetail> {
    return this.settlements.detailForOwner(tenantId, id);
  }

  @Get(':id/document')
  async document(@Tenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply): Promise<void> {
    sendSettlementDocument(res, await this.settlements.detailForOwner(tenantId, id));
  }

  @Get(':id/csv')
  async csv(@Tenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: FastifyReply): Promise<void> {
    sendSettlementCsv(res, await this.settlements.detailForOwner(tenantId, id));
  }
}
