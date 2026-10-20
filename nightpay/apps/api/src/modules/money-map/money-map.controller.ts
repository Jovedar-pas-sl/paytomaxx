import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { MoneyMapQuerySchema, type MoneyMap, type MoneyMapQuery } from '@nightpay/contracts';
import { Roles } from '../../common/decorators/roles.decorator';
import { Tenant } from '../../common/decorators/tenant.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { RequiresPermission, StaffPermissionGuard } from '../venues/staff-permission.guard';
import { MoneyMapService } from './money-map.service';

/**
 * El mapa del dinero del panel (maqueta 8 · A):
 *   GET /v1/admin/money-map                     → la noche abierta, en directo.
 *   GET /v1/admin/money-map?night=<id>          → una noche (la cerrada, congelada en su Z).
 *   GET /v1/admin/money-map?from=AAAA-MM-DD&to=AAAA-MM-DD → unas fechas (días de Madrid).
 * El dueño, y el encargado si el dueño le deja ver los informes.
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class MoneyMapController {
  private readonly moneyMap: MoneyMapService;

  constructor(@Inject(MoneyMapService) moneyMap: MoneyMapService) {
    this.moneyMap = moneyMap;
  }

  @Get('money-map')
  @Roles('OWNER', 'MANAGER')
  @UseGuards(StaffPermissionGuard)
  @RequiresPermission('reports')
  async get(
    @Tenant() tenantId: string,
    @Query(new ZodValidationPipe(MoneyMapQuerySchema)) q: MoneyMapQuery,
  ): Promise<MoneyMap> {
    return this.moneyMap.forQuery(tenantId, q);
  }
}
