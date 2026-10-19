import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { alertSettingsOf, type JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ACKABLE_KINDS, type Incident } from './incident-rules';
import { IncidentsService } from './incidents.service';
import { TelegramService } from './telegram.service';
import { BRAND_NAME } from '../../common/brand';

const AckSchema = z.object({
  kind: z.enum(ACKABLE_KINDS),
  // El de las diferencias con el banco es una clave compuesta (bankMismatchKey)
  // que pasa de 64 caracteres; el servicio comprueba que exista en la bandeja.
  refId: z.string().trim().min(1).max(512),
  note: z.string().trim().max(300).optional(),
});
type AckBody = z.infer<typeof AckSchema>;

/**
 * Bandeja de incidencias (Fase 1E).
 *  - GET  /v1/incidents                → lo que hay que mirar (+ si Telegram está activo).
 *  - POST /v1/incidents/ack            → marcar como revisada (solo el dueño).
 *  - POST /v1/incidents/telegram-test  → mensaje de prueba al chat del local (Ajustes → Avisos).
 */
@Controller('incidents')
@UseGuards(RolesGuard)
export class IncidentsController {
  private readonly incidents: IncidentsService;
  private readonly telegram: TelegramService;
  private readonly prisma: PrismaService;

  constructor(
    @Inject(IncidentsService) incidents: IncidentsService,
    @Inject(TelegramService) telegram: TelegramService,
    @Inject(PrismaService) prisma: PrismaService,
  ) {
    this.incidents = incidents;
    this.telegram = telegram;
    this.prisma = prisma;
  }

  @Get()
  @Roles('OWNER', 'MANAGER')
  async list(@CurrentUser() user: JwtPayload): Promise<{ items: Incident[]; telegram: boolean }> {
    const [items, chatId] = await Promise.all([this.incidents.list(user.tenantId), this.venueChatId(user.tenantId)]);
    return { items, telegram: this.telegram.isConfigured(chatId) };
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
  async telegramTest(@CurrentUser() user: JwtPayload): Promise<{ sent: boolean }> {
    // Al chat del local (Ajustes → Avisos) o, sin él, al de todos los locales.
    const chatId = await this.venueChatId(user.tenantId);
    return { sent: await this.telegram.send(`✅ ${BRAND_NAME}: las alertas de este local llegan a este chat.`, chatId) };
  }

  /** Chat propio del local (null = el de TELEGRAM_CHAT_ID). */
  private async venueChatId(tenantId: string): Promise<string | null> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: tenantId }, select: { alertSettings: true } }),
    );
    return alertSettingsOf(venue?.alertSettings).chatId;
  }
}
