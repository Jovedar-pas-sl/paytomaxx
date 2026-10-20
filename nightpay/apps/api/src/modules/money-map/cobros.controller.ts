import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  CobrosQuerySchema,
  type CobrosPage,
  type CobrosQuery,
  type InvitationSummary,
  type WalletFicha,
} from '@nightpay/contracts';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CobrosService } from './cobros.service';
import { WalletFichaService } from './wallet-ficha.service';

/**
 * El mapa del dinero en el panel:
 *  - GET /v1/admin/cobros              → cobros con tarjeta y del saldo, juntos, con su
 *    referencia, chica, sección, cómo pagó y servicio. Filtros: operatorId,
 *    category, method, walletCode, walletId, nightId, status; cursor y limit.
 *  - GET /v1/admin/wallets/:id/ficha   → ficha del saldo: recargas, consumos y devoluciones.
 *  - GET /v1/admin/operators/:id/invitaciones → las invitaciones a una chica (cuántas, cuánto y su parte).
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class CobrosController {
  private readonly cobros: CobrosService;
  private readonly fichas: WalletFichaService;

  constructor(@Inject(CobrosService) cobros: CobrosService, @Inject(WalletFichaService) fichas: WalletFichaService) {
    this.cobros = cobros;
    this.fichas = fichas;
  }

  @Get('cobros')
  @Roles('OWNER', 'MANAGER')
  async list(
    @Tenant() tenantId: string,
    @Query(new ZodValidationPipe(CobrosQuerySchema)) q: CobrosQuery,
  ): Promise<CobrosPage> {
    return this.cobros.list(tenantId, q);
  }

  @Get('operators/:id/invitaciones')
  @Roles('OWNER', 'MANAGER')
  async invitations(@Tenant() tenantId: string, @Param('id', ParseUUIDPipe) operatorId: string): Promise<InvitationSummary> {
    return this.cobros.invitationSummary(tenantId, operatorId);
  }

  @Get('wallets/:id/ficha')
  @Roles('OWNER', 'MANAGER')
  async walletFicha(@Tenant() tenantId: string, @Param('id', ParseUUIDPipe) walletId: string): Promise<WalletFicha> {
    return this.fichas.ficha(tenantId, walletId);
  }
}
