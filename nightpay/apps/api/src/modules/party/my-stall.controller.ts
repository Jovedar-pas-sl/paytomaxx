import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { SetMyStallOpenSchema, type JwtPayload, type MyStallResponse, type SetMyStallOpenDto } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PartyEditionGuard } from './party-edition.guard';
import { StallsService } from './stalls.service';

/**
 * «Abierta ahora» desde la app del personal (OxioParty; con EDITION=club, 404).
 *  - GET   /v1/party/my-stall   la caseta de quien lo pide ({ stall: null } sin caseta)
 *  - PATCH /v1/party/my-stall   { openNow }: abrir o cerrar la suya (sin caseta, 409 NO_STALL)
 * Solo la suya: la caseta sale de la persona, nunca de la petición. La
 * organización abre o cierra cualquiera desde el panel (PATCH /v1/admin/party/stalls/:id).
 */
@Controller('party/my-stall')
@UseGuards(PartyEditionGuard, RolesGuard)
export class MyStallController {
  constructor(@Inject(StallsService) private readonly stalls: StallsService) {}

  @Get()
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async get(@CurrentUser() user: JwtPayload): Promise<MyStallResponse> {
    return { stall: await this.stalls.mine(user) };
  }

  @Patch()
  @Roles('MANAGER', 'WAITER', 'OPERATOR')
  async set(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(SetMyStallOpenSchema)) dto: SetMyStallOpenDto): Promise<MyStallResponse> {
    return { stall: await this.stalls.setMineOpen(user, dto.openNow) };
  }
}
