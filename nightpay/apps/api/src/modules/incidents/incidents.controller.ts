import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { JwtPayload } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import type { Incident } from './incident-rules';
import { IncidentsService } from './incidents.service';
import { TelegramService } from './telegram.service';
import { BRAND_NAME } from '../../common/brand';

const AckSchema = z.object({
  kind: z.enum([
    'duplicate_charge',
    'earning_reverse_failed',
    'wallet_credit_skipped',
    'night_closed_pending',
    'pos_charge_mismatch',
    'pos_unmatched_op',
  ]),
  refId: z.string().trim().min(1).max(64),
  note: z.string().trim().max(300).optional(),
});
type AckBody = z.infer<typeof AckSchema>;

/**
 * Bandeja de incidencias (Fase 1E).
 *  - GET  /v1/incidents                → lo que hay que mirar (+ si Telegram está activo).
 *  - POST /v1/incidents/ack            → marcar como revisada (solo el dueño).
 *  - POST /v1/incidents/telegram-test  → mensaje de prueba al Telegram del dueño.
 */
@Controller('incidents')
@UseGuards(RolesGuard)
export class IncidentsController {
  private readonly incidents: IncidentsService;
  private readonly telegram: TelegramService;

  constructor(
    @Inject(IncidentsService) incidents: IncidentsService,
    @Inject(TelegramService) telegram: TelegramService,
  ) {
    this.incidents = incidents;
    this.telegram = telegram;
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@CurrentUser() user: JwtPayload): Promise<{ items: Incident[]; telegram: boolean }> {
    return { items: await this.incidents.list(user.tenantId), telegram: this.telegram.isConfigured() };
  }

  @Post('ack')
  @HttpCode(200)
  @Roles('OWNER')
  async ack(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(AckSchema)) body: AckBody,
  ): Promise<{ ok: true }> {
    await this.incidents.ack(user.tenantId, user.sub, body);
    return { ok: true };
  }

  @Post('telegram-test')
  @HttpCode(200)
  @Roles('OWNER')
  async telegramTest(): Promise<{ sent: boolean }> {
    // Un solo chat para todos los locales del dueño.
    return { sent: await this.telegram.send(`✅ ${BRAND_NAME}: las alertas de tus locales llegan a este chat.`) };
  }
}
