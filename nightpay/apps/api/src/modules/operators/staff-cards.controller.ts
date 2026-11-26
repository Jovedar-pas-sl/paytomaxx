import { Body, Controller, Delete, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  IssueStaffCardSchema,
  ResolveStaffCardSchema,
  type IssueStaffCardDto,
  type JwtPayload,
  type ResolveStaffCardDto,
  type StaffCardResolved,
  type StaffCardView,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { StaffCardsService } from './staff-cards.service';

/**
 * La ficha NFC de la compañera (cobro por el encargado, fase 2):
 *  - POST   /v1/admin/operators/:id/staff-card/token → su código, antes de grabar la ficha en blanco.
 *  - POST   /v1/admin/operators/:id/staff-card → la ficha recién grabada es la suya (la de antes deja de valer).
 *  - DELETE /v1/admin/operators/:id/staff-card → anularla.
 *  - POST   /v1/operators/staff-card/resolve   → quien cobra a su nombre la acerca: de quién es.
 */
@Controller()
@UseGuards(RolesGuard)
export class StaffCardsController {
  private readonly cards: StaffCardsService;

  constructor(@Inject(StaffCardsService) cards: StaffCardsService) {
    this.cards = cards;
  }

  @Post('admin/operators/:id/staff-card/token')
  @HttpCode(201)
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'staff-card-issue' })
  async reserve(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ card: string }> {
    return this.cards.reserve({ userId: user.sub, tenantId: user.tenantId }, id);
  }

  @Post('admin/operators/:id/staff-card')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'staff-card-issue' })
  async issue(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(IssueStaffCardSchema)) body: IssueStaffCardDto,
  ): Promise<StaffCardView> {
    return this.cards.issue({ userId: user.sub, tenantId: user.tenantId }, id, body);
  }

  @Delete('admin/operators/:id/staff-card')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  async revoke(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ revoked: number | null }> {
    return this.cards.revoke({ userId: user.sub, tenantId: user.tenantId }, id);
  }

  @Post('operators/staff-card/resolve')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'staff-card-resolve' })
  async resolve(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ResolveStaffCardSchema)) body: ResolveStaffCardDto,
  ): Promise<StaffCardResolved> {
    return this.cards.resolve({ userId: user.sub, tenantId: user.tenantId }, body);
  }
}
