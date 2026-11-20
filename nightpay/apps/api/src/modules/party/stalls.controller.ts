import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import {
  AssignStallSchema,
  CreateStallSchema,
  UpdateStallSchema,
  type AssignStallDto,
  type CreateStallDto,
  type JwtPayload,
  type StallStaffPerson,
  type StallView,
  type UpdateStallDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PartyEditionGuard } from './party-edition.guard';
import { StallsService } from './stalls.service';

/**
 * Casetas de la fiesta (OxioParty; con EDITION=club, 404). Dueño y encargado.
 *  - GET    /v1/admin/party/stalls          las casetas (con cuántas personas tiene cada una)
 *  - POST   /v1/admin/party/stalls          nueva (con la 2FA activada, el código: la parte del organizador es dinero)
 *  - PATCH  /v1/admin/party/stalls/:id      cambiar (la parte del organizador o el IBAN: con el código si hay 2FA)
 *  - DELETE /v1/admin/party/stalls/:id      borrar una sin cobros (con cobros: 409 STALL_IN_USE, se desactiva)
 *  - GET    /v1/admin/party/staff           el personal con su caseta
 *  - PATCH  /v1/admin/party/staff/:userId   cambiar la caseta de una persona ({ stallId } o null)
 */
@Controller('admin/party')
@UseGuards(PartyEditionGuard, RolesGuard)
export class StallsController {
  constructor(@Inject(StallsService) private readonly stalls: StallsService) {}

  @Get('stalls')
  @Roles('OWNER', 'MANAGER')
  list(@CurrentUser() user: JwtPayload): Promise<StallView[]> {
    return this.stalls.list(user.tenantId);
  }

  @Post('stalls')
  @Roles('OWNER', 'MANAGER')
  create(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(CreateStallSchema)) dto: CreateStallDto): Promise<StallView> {
    return this.stalls.create(user, dto);
  }

  @Patch('stalls/:id')
  @Roles('OWNER', 'MANAGER')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateStallSchema)) dto: UpdateStallDto,
  ): Promise<StallView> {
    return this.stalls.update(user, id, dto);
  }

  @Delete('stalls/:id')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  remove(@CurrentUser() user: JwtPayload, @Param('id', new ParseUUIDPipe()) id: string): Promise<{ deleted: true; unassignedStaff: number }> {
    return this.stalls.remove(user, id);
  }

  @Get('staff')
  @Roles('OWNER', 'MANAGER')
  staff(@CurrentUser() user: JwtPayload): Promise<StallStaffPerson[]> {
    return this.stalls.staff(user.tenantId);
  }

  @Patch('staff/:userId')
  @Roles('OWNER', 'MANAGER')
  assign(
    @CurrentUser() user: JwtPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(AssignStallSchema)) dto: AssignStallDto,
  ): Promise<StallStaffPerson> {
    return this.stalls.assign(user, userId, dto);
  }
}
