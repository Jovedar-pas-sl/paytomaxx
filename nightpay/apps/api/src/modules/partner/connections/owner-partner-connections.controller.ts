import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  CreatePartnerConnectionSchema,
  PartnerConnectionNoBodySchema,
  ResumePartnerConnectionSchema,
  RotatePartnerKeySchema,
  type CreatePartnerConnectionDto,
  type JwtPayload,
  type PartnerConnectionView,
  type PartnerConnectionsOverview,
  type PartnerKeyIssued,
  type ResumePartnerConnectionDto,
  type RotatePartnerKeyDto,
} from '@nightpay/contracts';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { UserRateLimit, UserRateLimitGuard } from '../../../common/guards/user-rate-limit.guard';
import { ZodValidationPipe } from '../../../common/pipes/zod.pipe';
import { PartnerApiEnabledGuard } from '../partner-flag';
import { PartnerConnectionsService } from './partner-connections.service';

const WRITE_LIMIT = { max: 10, windowSec: 60, scope: 'partner-connections-write' };

/**
 * Ajustes → «Otras plataformas» (el panel llega en la parte B): el dueño
 * conecta, cambia la clave (2FA), pausa, reanuda (2FA) y anula; el encargado
 * ve, pausa y anula. Con la API apagada (o en OxioParty) no existe (404).
 *  - GET  /v1/admin/partner-connections
 *  - POST /v1/admin/partner-connections                 conectar (la clave sale una vez)
 *  - POST /v1/admin/partner-connections/:id/rotate      cambiar la clave
 *  - POST /v1/admin/partner-connections/:id/pause|revoke|resume
 */
@Controller('admin/partner-connections')
@UseGuards(PartnerApiEnabledGuard, RolesGuard, UserRateLimitGuard)
@Roles('OWNER', 'MANAGER')
export class OwnerPartnerConnectionsController {
  constructor(@Inject(PartnerConnectionsService) private readonly connections: PartnerConnectionsService) {}

  @Get()
  overview(@CurrentUser() user: JwtPayload): Promise<PartnerConnectionsOverview> {
    return this.connections.overview(user);
  }

  @Post()
  @Roles('OWNER')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UserRateLimit(WRITE_LIMIT)
  create(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(CreatePartnerConnectionSchema)) dto: CreatePartnerConnectionDto,
  ): Promise<PartnerKeyIssued> {
    return this.connections.create(user, dto);
  }

  @Post(':id/rotate')
  @Roles('OWNER')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UserRateLimit(WRITE_LIMIT)
  rotate(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(RotatePartnerKeySchema)) dto: RotatePartnerKeyDto,
  ): Promise<PartnerKeyIssued> {
    return this.connections.rotate(user, id, dto);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @UserRateLimit(WRITE_LIMIT)
  pause(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerConnectionNoBodySchema)) _body: unknown,
  ): Promise<PartnerConnectionView> {
    return this.connections.pause(user, id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @UserRateLimit(WRITE_LIMIT)
  revoke(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PartnerConnectionNoBodySchema)) _body: unknown,
  ): Promise<PartnerConnectionView> {
    return this.connections.revoke(user, id);
  }

  @Post(':id/resume')
  @Roles('OWNER')
  @HttpCode(200)
  @UserRateLimit(WRITE_LIMIT)
  resume(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ResumePartnerConnectionSchema)) dto: ResumePartnerConnectionDto,
  ): Promise<PartnerConnectionView> {
    return this.connections.resume(user, id, dto);
  }
}
