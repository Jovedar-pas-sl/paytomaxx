import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { MoneyMapQuerySchema, type JwtPayload, type MoneyMap, type MoneyMapQuery, type StaffFicha } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { blindMoneyMap, blindsCash } from '../nights/blind-cash';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { MoneyMapService } from './money-map.service';
import { StaffFichaService } from './staff-ficha.service';

/**
 * El mapa del dinero del panel (maqueta 8 · A):
 *   GET /v1/admin/money-map                     → la noche abierta, en directo.
 *   GET /v1/admin/money-map?night=<id>          → una noche (la cerrada, congelada en su Z).
 *   GET /v1/admin/money-map?from=AAAA-MM-DD&to=AAAA-MM-DD → unas fechas (días de Madrid).
 * El dueño, y el encargado si el dueño le deja ver los informes.
 *   GET /v1/admin/operators/:id/ficha           → ficha de la chica o del camarero (maqueta 9.2),
 *     esta noche: sus cobros con su parte, lo vendido, lo suyo y lo pagado. Dueño y encargado.
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class MoneyMapController {
  private readonly moneyMap: MoneyMapService;
  private readonly fichas: StaffFichaService;

  constructor(@Inject(MoneyMapService) moneyMap: MoneyMapService, @Inject(StaffFichaService) fichas: StaffFichaService) {
    this.moneyMap = moneyMap;
    this.fichas = fichas;
  }

  @Get('money-map')
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('reports')
  async get(
    @CurrentUser() user: JwtPayload,
    @Query(new ZodValidationPipe(MoneyMapQuerySchema)) q: MoneyMapQuery,
  ): Promise<MoneyMap> {
    const map = await this.moneyMap.forQuery(user.tenantId, q);
    // Cierre a ciegas: la encargada, en directo con la noche abierta, sin la caja esperada.
    const live = map.scope.kind === 'night' && map.scope.open && !map.frozen;
    return blindsCash(user.role, live) ? blindMoneyMap(map) : map;
  }

  @Get('operators/:id/ficha')
  @Roles('OWNER', 'MANAGER')
  async staffFicha(@Tenant() tenantId: string, @Param('id', ParseUUIDPipe) personId: string): Promise<StaffFicha> {
    return this.fichas.ficha(tenantId, personId);
  }
}
