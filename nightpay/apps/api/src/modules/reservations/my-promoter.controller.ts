import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { JwtPayload, MyPromoterPage } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MyPromoterService } from './my-promoter.service';

/**
 * GET /v1/staff/me/promoter: la página del RRPP en la app del personal. Solo
 * lo suyo: la persona y el local salen de la sesión, nunca de la petición.
 */
@Controller('staff/me')
@UseGuards(RolesGuard)
export class MyPromoterController {
  constructor(@Inject(MyPromoterService) private readonly service: MyPromoterService) {}

  @Get('promoter')
  @Roles('OPERATOR', 'WAITER', 'MANAGER', 'OWNER')
  async page(@CurrentUser() u: JwtPayload): Promise<MyPromoterPage> {
    return { promoter: await this.service.forUser({ userId: u.sub, tenantId: u.tenantId, role: u.role }) };
  }
}
