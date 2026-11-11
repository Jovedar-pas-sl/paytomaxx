import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  CobroKindParamSchema,
  CobrosQuerySchema,
  type CobroDetail,
  type CobroDetailSensitive,
  type CobroKind,
  type CobrosPage,
  type JwtPayload,
  type CobrosQuery,
  type InvitationSummary,
  type WalletFicha,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { CobroDetailService } from './cobro-detail.service';
import { CobrosService } from './cobros.service';
import { WalletFichaService } from './wallet-ficha.service';

/**
 * El mapa del dinero en el panel:
 *  - GET /v1/admin/cobros              → cobros con tarjeta y del saldo, juntos, con su
 *    referencia, chica, sección, cómo pagó y servicio. Filtros: operatorId,
 *    category, method, walletCode, walletId, nightId, status; cursor y limit.
 *  - GET /v1/admin/wallets/:id/ficha   → ficha del saldo: recargas, consumos y devoluciones.
 *  - GET /v1/admin/operators/:id/invitaciones → las invitaciones a una chica (cuántas, cuánto y su parte).
 *  - GET /v1/admin/cobros/:kind/:id    → «Ver detalle» de un cobro (PAYMENT o SALDO).
 *  - GET /v1/admin/cobros/:kind/:id/sensitive → solo lo delicado (con la verificación del momento).
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class CobrosController {
  private readonly cobros: CobrosService;
  private readonly fichas: WalletFichaService;

  private readonly details: CobroDetailService;

  constructor(
    @Inject(CobrosService) cobros: CobrosService,
    @Inject(WalletFichaService) fichas: WalletFichaService,
    @Inject(CobroDetailService) details: CobroDetailService,
  ) {
    this.cobros = cobros;
    this.fichas = fichas;
    this.details = details;
  }

  /**
   * «Ver detalle»: todo lo del cobro para el encargado y el dueño (el reparto
   * entero, el dueño y el encargado con «Informes»). Lo delicado viene con
   * `sensitive: null` y `verify.required` hasta verificarse (5 minutos).
   */
  @Get('cobros/:kind/:id')
  @Roles('OWNER', 'MANAGER')
  async detail(
    @CurrentUser() user: JwtPayload,
    @Param('kind', new ZodValidationPipe(CobroKindParamSchema)) kind: CobroKind,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CobroDetail> {
    return this.details.forManager(user, kind, id);
  }

  /** Solo lo delicado: sin la verificación vigente, 403 STEP_UP_REQUIRED. */
  @Get('cobros/:kind/:id/sensitive')
  @Roles('OWNER', 'MANAGER')
  async sensitive(
    @CurrentUser() user: JwtPayload,
    @Param('kind', new ZodValidationPipe(CobroKindParamSchema)) kind: CobroKind,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CobroDetailSensitive> {
    return this.details.sensitiveFor(user, kind, id, 'MANAGER');
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
