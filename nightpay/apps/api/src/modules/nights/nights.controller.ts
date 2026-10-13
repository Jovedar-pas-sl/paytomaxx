import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { NightsService, type MyNight, type NightListItem, type NightView } from './nights.service';

const CloseNightSchema = z.object({
  /** Cerrar aunque queden cobros sin resolver (solo el dueño, con nota). */
  force: z.boolean().optional().default(false),
  note: z.string().trim().max(300).optional(),
});
type CloseNightBody = z.infer<typeof CloseNightSchema>;

/**
 * Noche del local (Fase 1D).
 *  - GET  /v1/nights/current     → noche abierta con su Z en vivo y lo pendiente.
 *  - POST /v1/nights/open        → abrir (una sola abierta por local).
 *  - POST /v1/nights/:id/close   → cerrar y congelar el Z.
 *  - GET  /v1/nights             → últimas noches.
 *  - GET  /v1/nights/:id         → una noche con su Z.
 *  - GET  /v1/nights/mine        → la noche en curso de la chica que llama.
 */
@Controller('nights')
@UseGuards(RolesGuard)
export class NightsController {
  private readonly nights: NightsService;

  constructor(@Inject(NightsService) nights: NightsService) {
    this.nights = nights;
  }

  @Get('current')
  @Roles('OWNER', 'MANAGER')
  async current(@CurrentUser() user: JwtPayload): Promise<{ night: NightView | null }> {
    return { night: await this.nights.current(user.tenantId) };
  }

  @Get('mine')
  @Roles('OPERATOR')
  async mine(@CurrentUser() user: JwtPayload): Promise<MyNight> {
    return this.nights.mine(user.tenantId, user.sub);
  }

  @Post('open')
  @HttpCode(201)
  @Roles('OWNER', 'MANAGER')
  async open(@CurrentUser() user: JwtPayload): Promise<NightView> {
    return this.nights.open(user.tenantId, user.sub);
  }

  @Post(':id/close')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  async close(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(CloseNightSchema)) body: CloseNightBody,
  ): Promise<NightView> {
    return this.nights.close(user.tenantId, { userId: user.sub, role: user.role }, id, {
      force: body.force,
      note: body.note,
    });
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@CurrentUser() user: JwtPayload): Promise<NightListItem[]> {
    return this.nights.list(user.tenantId);
  }

  @Get(':id')
  @Roles('OWNER', 'MANAGER')
  async get(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<NightView> {
    return this.nights.get(user.tenantId, id);
  }
}
