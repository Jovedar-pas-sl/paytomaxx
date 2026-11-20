import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  PreparePulserasSchema,
  ReplacePulseraSchema,
  type JwtPayload,
  type PreparePulserasDto,
  type PreparedPulseras,
  type PulserasView,
  type ReplacePulseraDto,
  type ReplacedPulsera,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PartyEditionGuard } from './party-edition.guard';
import { PulserasService, sheetRange } from './pulseras.service';

/**
 * Pulseras de la fiesta en el panel (OxioParty; con EDITION=club, 404). Dueño y encargado.
 *  - GET  /v1/admin/party/pulseras?q=&status=          recuento por estado y la lista (buscador: «P-0412», «412» o el código del saldo)
 *  - POST /v1/admin/party/pulseras/lote                { count } pulseras nuevas al stock (como mucho 500)
 *  - GET  /v1/admin/party/pulseras/hoja?desde=&hasta=  hoja para imprimir (HTML): número y QR de cada una
 *  - POST /v1/admin/party/pulseras/:id/sustituir       { nueva }: la perdida se bloquea y su saldo pasa a la nueva
 * Bloquear sin más (o marcarla perdida) es lo de siempre: POST /v1/wallet-cards/:id/block | /lost.
 */
@Controller('admin/party')
@UseGuards(PartyEditionGuard, RolesGuard)
export class PulserasController {
  constructor(@Inject(PulserasService) private readonly pulseras: PulserasService) {}

  @Get('pulseras')
  @Roles('OWNER', 'MANAGER')
  view(@CurrentUser() user: JwtPayload, @Query('q') q?: string, @Query('status') status?: string): Promise<PulserasView> {
    return this.pulseras.view(user.tenantId, { q: typeof q === 'string' ? q : undefined, status: typeof status === 'string' ? status : undefined });
  }

  @Post('pulseras/lote')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 10, windowSec: 60, scope: 'party-pulseras-lote' })
  prepare(@CurrentUser() user: JwtPayload, @Body(new ZodValidationPipe(PreparePulserasSchema)) dto: PreparePulserasDto): Promise<PreparedPulseras> {
    return this.pulseras.prepare({ userId: user.sub, role: user.role, tenantId: user.tenantId, email: user.email }, dto.count);
  }

  @Get('pulseras/hoja')
  @Roles('OWNER', 'MANAGER')
  @IpRateLimit({ max: 20, windowSec: 60, scope: 'party-pulseras-hoja' })
  async sheet(
    @CurrentUser() user: JwtPayload,
    @Res() res: FastifyReply,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ): Promise<void> {
    const html = await this.pulseras.sheet(user.tenantId, sheetRange(desde, hasta));
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .send(html);
  }

  @Post('pulseras/:id/sustituir')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  replace(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReplacePulseraSchema)) dto: ReplacePulseraDto,
  ): Promise<ReplacedPulsera> {
    return this.pulseras.replace({ userId: user.sub, role: user.role, tenantId: user.tenantId, email: user.email }, id, dto.nueva);
  }
}
