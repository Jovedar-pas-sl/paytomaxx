import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, Logger, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { alertSettingsOf, type JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { AlertsService } from './alerts.service';
import { ACKABLE_KINDS, type Incident } from './incident-rules';
import { IncidentsService } from './incidents.service';
import { TelegramService } from './telegram.service';
import { BRAND_NAME } from '../../common/brand';
import { assertCanTopUp } from '../venues/charge-rights';

const AckSchema = z.object({
  kind: z.enum(ACKABLE_KINDS),
  // El de las diferencias con el banco es una clave compuesta (bankMismatchKey)
  // que pasa de 64 caracteres; el servicio comprueba que exista en la bandeja.
  refId: z.string().trim().min(1).max(512),
  note: z.string().trim().max(300).optional(),
});
type AckBody = z.infer<typeof AckSchema>;

/** Recepción cierra un «No he sido yo» con su nota. */
const ReceptionAckSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('kind' in v) ? { ...v, kind: 'wallet_charge_disputed' } : v),
  z.discriminatedUnion('kind', [
  // «No he sido yo» (la app de antes no manda `kind`: se pone este).
  z.object({ kind: z.literal('wallet_charge_disputed'), refId: z.string().uuid(), note: z.string().trim().max(300).optional() }),
  // «Pagó después de cancelar»: su id es el del evento (un número).
  z.object({ kind: z.literal('approval_unbooked'), refId: z.string().regex(/^\d{1,19}$/), note: z.string().trim().max(300).optional() }),
  ]),
);
type ReceptionAckBody = z.infer<typeof ReceptionAckSchema>;

const NotifySchema = z.object({ paymentId: z.string().uuid() });
type NotifyBody = z.infer<typeof NotifySchema>;

/** Ven (y avisan de) los cobros de todo el local; el resto, solo de los suyos. */
const VENUE_WIDE: ReadonlySet<string> = new Set(['OWNER', 'MANAGER']);
/** Un cobro que espera al banco: el que se puede avisar al encargado. */
const WAITING_BANK: ReadonlySet<string> = new Set(['ORPHAN', 'AUTHORIZING']);

/**
 * Bandeja de incidencias (Fase 1E).
 *  - GET  /v1/incidents                → lo que hay que mirar (+ si Telegram está activo).
 *  - POST /v1/incidents/ack            → marcar como revisada (solo el dueño).
 *  - POST /v1/incidents/telegram-test  → mensaje de prueba al chat del local (Ajustes → Avisos).
 *  - POST /v1/incidents/notify         → «Avisar al encargado» de un cobro que el banco no confirma.
 */
@Controller('incidents')
@UseGuards(RolesGuard)
export class IncidentsController {
  private readonly logger = new Logger(IncidentsController.name);
  private readonly incidents: IncidentsService;
  private readonly telegram: TelegramService;
  private readonly prisma: PrismaService;
  private readonly alerts: AlertsService;

  constructor(
    @Inject(IncidentsService) incidents: IncidentsService,
    @Inject(TelegramService) telegram: TelegramService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AlertsService) alerts: AlertsService,
  ) {
    this.incidents = incidents;
    this.telegram = telegram;
    this.prisma = prisma;
    this.alerts = alerts;
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

  /**
   * Recepción (app del personal): los «El cliente dice que no ha sido él» del
   * local y los «Pagó después de cancelar». Quien carga saldos (recepción, el
   * encargado o el dueño) los ve; los primeros los cierra con su nota
   * (desbloquear el PIN sigue siendo del encargado); los segundos, solo el
   * encargado o el dueño (devuelto en el banco o dado por bueno).
   */
  @Get('recepcion')
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 60, windowSec: 60, scope: 'incidents-reception' })
  async receptionList(@CurrentUser() user: JwtPayload): Promise<{ items: Incident[] }> {
    await this.assertReception(user);
    return { items: await this.incidents.receptionInbox(user.tenantId, user.role) };
  }

  @Post('recepcion/ack')
  @HttpCode(200)
  @Roles('WAITER', 'MANAGER', 'OWNER')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'incidents-reception' })
  async receptionAck(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(ReceptionAckSchema)) body: ReceptionAckBody,
  ): Promise<{ ok: true }> {
    await this.assertReception(user);
    if (body.kind === 'approval_unbooked') {
      if (user.role !== 'MANAGER' && user.role !== 'OWNER') {
        throw new ForbiddenException('Este aviso lo cierra el encargado o el dueño');
      }
      await this.incidents.ackPaidAfterCancel(user.tenantId, user.sub, body);
    } else {
      await this.incidents.ackDisputed(user.tenantId, user.sub, body);
    }
    return { ok: true };
  }

  /** Solo quien carga saldos en este local (como las recargas de recepción). */
  private async assertReception(user: JwtPayload): Promise<void> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, user.tenantId, { userId: user.sub, role: user.role }));
  }

  @Post('telegram-test')
  @HttpCode(200)
  @Roles('OWNER')
  async telegramTest(@CurrentUser() user: JwtPayload): Promise<{ sent: boolean }> {
    // Al chat del local (Ajustes → Avisos) o, sin él, al de todos los locales.
    const chatId = await this.venueChatId(user.tenantId);
    return { sent: await this.telegram.send(`✅ ${BRAND_NAME}: las alertas de este local llegan a este chat.`, chatId) };
  }

  /**
   * «Avisar al encargado» (Esperando, «El banco no lo ha confirmado»): la
   * incidencia del cobro, ya en la bandeja, llega ahora por Telegram (una
   * sola vez, AlertsService.notifyPaymentNow). Del local de quien avisa; la
   * chica y el camarero, solo de sus cobros; y solo si sigue esperando al banco.
   */
  @Post('notify')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  @IpRateLimit({ max: 30, windowSec: 60, scope: 'incident-notify' })
  async notify(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(NotifySchema)) body: NotifyBody,
  ): Promise<{ notified: boolean; telegram: boolean }> {
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findFirst({ where: { id: body.paymentId, tenantId: user.tenantId }, select: { createdByUserId: true, status: true } }),
    );
    if (!payment || (!VENUE_WIDE.has(user.role) && payment.createdByUserId !== user.sub)) {
      throw new NotFoundException('Cobro no encontrado');
    }
    if (!WAITING_BANK.has(payment.status)) {
      throw new ConflictException({ message: 'Este cobro ya no está esperando al banco.', code: 'PAYMENT_NOT_WAITING' });
    }
    const result = await this.alerts.notifyPaymentNow(user.tenantId, body.paymentId);
    this.logger.log(`Aviso al encargado del cobro ${body.paymentId} (${payment.status}) por ${user.sub}: telegram=${result.telegram} enviado=${result.sent}`);
    return { notified: result.sent, telegram: result.telegram };
  }

  /** Chat propio del local (null = el de TELEGRAM_CHAT_ID). */
  private async venueChatId(tenantId: string): Promise<string | null> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: tenantId }, select: { alertSettings: true } }),
    );
    return alertSettingsOf(venue?.alertSettings).chatId;
  }
}
