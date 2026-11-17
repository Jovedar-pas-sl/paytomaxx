import { Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import * as QRCode from 'qrcode';
import {
  CreateReservationSchema,
  ReservationChangeDateSchema,
  ReservationPaySchema,
  type CreateReservationDto,
  type ReservationPayKind,
} from '@nightpay/contracts';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ReservationCatalogService } from './reservation-catalog.service';
import { renderBookPage, renderGroupPage, renderGuestPage, renderReservationGone } from './reservation-pages';
import { MAX_DAYS_AHEAD, nightOf } from './reservation-rules';
import { RESERVATION_GONE, ReservationsService, type BookingEntry } from './reservations.service';

const PAGE_LIMIT = { max: 120, windowSec: 60, scope: 'reservas-page' } as const;
const BOOK_LIMIT = { max: 10, windowSec: 15 * 60, scope: 'reservas-book' } as const;
const PAY_LIMIT = { max: 20, windowSec: 15 * 60, scope: 'reservas-pay' } as const;

/** Las noches que se ofrecen en el calendario: desde esta noche hasta MAX_DAYS_AHEAD. */
function dayRange(now = new Date()): { min: string; max: string } {
  const min = nightOf(now);
  const max = new Date(Date.parse(`${min}T00:00:00Z`) + MAX_DAYS_AHEAD * 86_400_000).toISOString().slice(0, 10);
  return { min, max };
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .send(html);
}

/**
 * Reservar (fuera de /v1). El código del enlace dice desde dónde: 16 letras,
 * el del local (encendido en el panel); 12, el de un RRPP («vendido por»).
 *  - GET  /reservar/:code → elegir paquete y noche.
 *  - POST /reservar/:code → crea la reserva sin pagar y dice a dónde ir (su página).
 * Un código que no existe, apagado o de un RRPP dado de baja: 404 sin pistas.
 */
@Controller('reservar')
export class PublicBookingController {
  constructor(@Inject(ReservationsService) private readonly reservations: ReservationsService) {}

  private async entry(code: string): Promise<BookingEntry | null> {
    return code.length === 12 ? this.reservations.entryByPromoterCode(code) : this.reservations.entryByVenueCode(code);
  }

  @Public()
  @Get(':code')
  @IpRateLimit(PAGE_LIMIT)
  async page(@Param('code') code: string, @Res() res: FastifyReply): Promise<void> {
    const entry = await this.entry(code);
    if (!entry) return sendHtml(res, 404, renderReservationGone());
    const { min, max } = dayRange();
    sendHtml(res, 200, renderBookPage(code, entry, min, max));
  }

  @Public()
  @Post(':code')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(BOOK_LIMIT)
  async book(@Param('code') code: string, @Body(new ZodValidationPipe(CreateReservationSchema)) dto: CreateReservationDto): Promise<{ next: string }> {
    const entry = await this.entry(code);
    if (!entry) throw new NotFoundException({ message: RESERVATION_GONE, code: 'RESERVATION_GONE' });
    const created = await this.reservations.book(entry, dto);
    return { next: `/reservas/${created.manageToken}` };
  }
}

/**
 * El reservado del cliente (fuera de /v1):
 *  - GET  /reservas/:token        su página: pagar, los QR, lo que queda, cambiar la fecha.
 *  - POST /reservas/:token/pago   abre el pago con tarjeta (señal, resto o todo): a /pay.
 *  - POST /reservas/:token/fecha  cambia la fecha (una vez, con 48 h).
 *  - GET  /reservas/q/:token      el QR de una persona del grupo.
 */
@Controller('reservas')
export class PublicReservationController {
  constructor(
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(ReservationCatalogService) private readonly catalog: ReservationCatalogService,
  ) {}

  @Public()
  @Get('q/:token')
  @IpRateLimit(PAGE_LIMIT)
  async guest(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    const view = await this.reservations.guestView(token);
    if (!view) return sendHtml(res, 404, renderReservationGone());
    const qr = await QRCode.toDataURL(`${this.catalog.origin}/reservas/q/${token}`, { errorCorrectionLevel: 'M', margin: 2, width: 576 });
    sendHtml(res, 200, renderGuestPage(view, qr));
  }

  @Public()
  @Get(':token')
  @IpRateLimit(PAGE_LIMIT)
  async group(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    const view = await this.reservations.groupView(token);
    if (!view) return sendHtml(res, 404, renderReservationGone());
    const { min, max } = dayRange();
    sendHtml(res, 200, renderGroupPage(token, view, this.catalog.origin, min, max));
  }

  @Public()
  @Post(':token/pago')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(PAY_LIMIT)
  async pay(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(ReservationPaySchema)) dto: { kind: ReservationPayKind; acceptedNoRefund: true },
  ): Promise<{ payUrl: string }> {
    const started = await this.reservations.startPayment(token, dto.kind, 'es');
    return { payUrl: started.payUrl };
  }

  /** El cliente anula: sin pagar, «Cancelar»; pagada, con 48 h (pierde la señal; lo demás, saldo). */
  @Public()
  @Post(':token/anular')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(PAY_LIMIT)
  async cancel(@Param('token') token: string): Promise<{ ok: true }> {
    await this.reservations.clientCancel(token);
    return { ok: true };
  }

  @Public()
  @Post(':token/fecha')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @IpRateLimit(PAY_LIMIT)
  async changeDate(@Param('token') token: string, @Body(new ZodValidationPipe(ReservationChangeDateSchema)) dto: { nightDate: string }): Promise<{ ok: true }> {
    await this.reservations.changeDate(token, dto.nightDate);
    return { ok: true };
  }
}
