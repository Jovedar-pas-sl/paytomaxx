import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  CreateReservationSchema,
  ReservationCashSchema,
  ReservationSettingsSchema,
  PromoterCreateSchema,
  PromoterUpdateSchema,
  ReservationChangeDateSchema,
  ReservationChargeSchema,
  ReservationPackageActiveSchema,
  ReservationPackageInputSchema,
  ReservationServeSchema,
  ReservationTableSchema,
  ReservationVenueCancelSchema,
  type CreateReservationDto,
  type JwtPayload,
  type PromoterView,
  type ReservationAccounting,
  type ReservationCashQuote,
  type ReservationPackageInput,
  type ReservationPackageView,
  type ReservationView,
} from '@nightpay/contracts';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { ReservationCatalogService, type ReservationSettingsView } from './reservation-catalog.service';
import { ReservationOpsService, type StaffActor } from './reservation-ops.service';
import { PromotersService } from './promoters.service';
import { ReservationsService } from './reservations.service';

const actorOf = (u: JwtPayload): StaffActor => ({ userId: u.sub, role: u.role, tenantId: u.tenantId });
const DayQuery = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const GuestQuery = z.object({ qr: z.string().trim().min(16).max(400) }).strict();
const ArriveSchema = z.object({ guestId: z.string().uuid().optional() }).strict();

/**
 * Reservados (panel y app del personal), en /v1/reservations:
 *  - paquetes (dueño o encargado), el enlace web (dueño), reservar desde el panel;
 *  - la noche, el detalle, la mesa, la llegada, «Cobrar el resto», «No vino»;
 *  - el local cambia la fecha o anula;
 *  - barra: cobrar del paquete o servir una cosa con el QR de una persona;
 *  - «Señales de reservas».
 * Las chicas (OPERATOR) no entran.
 */
@Controller('reservations')
@UseGuards(RolesGuard)
export class ReservationsController {
  constructor(
    @Inject(ReservationsService) private readonly reservations: ReservationsService,
    @Inject(ReservationOpsService) private readonly ops: ReservationOpsService,
    @Inject(ReservationCatalogService) private readonly catalog: ReservationCatalogService,
    @Inject(PromotersService) private readonly promoters: PromotersService,
  ) {}

  // ─── RRPP ───────────────────────────────────────────────────────────

  @Get('promoters')
  @Roles('OWNER', 'MANAGER')
  listPromoters(@CurrentUser() u: JwtPayload): Promise<PromoterView[]> {
    return this.promoters.list(actorOf(u));
  }

  @Post('promoters')
  @Roles('OWNER')
  createPromoter(@CurrentUser() u: JwtPayload, @Body(new ZodValidationPipe(PromoterCreateSchema)) dto: { userId: string; commissionBps: number }): Promise<PromoterView> {
    return this.promoters.create(actorOf(u), dto);
  }

  @Patch('promoters/:id')
  @Roles('OWNER')
  updatePromoter(
    @CurrentUser() u: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(PromoterUpdateSchema)) dto: { commissionBps?: number; active?: boolean },
  ): Promise<PromoterView> {
    return this.promoters.update(actorOf(u), id, dto);
  }

  // ─── Paquetes y enlace ──────────────────────────────────────────────

  @Get('packages')
  @Roles('OWNER', 'MANAGER')
  packages(@CurrentUser() u: JwtPayload): Promise<ReservationPackageView[]> {
    return this.catalog.packages(actorOf(u));
  }

  @Post('packages')
  @Roles('OWNER', 'MANAGER')
  createPackage(@CurrentUser() u: JwtPayload, @Body(new ZodValidationPipe(ReservationPackageInputSchema)) dto: ReservationPackageInput): Promise<ReservationPackageView> {
    return this.catalog.createPackage(actorOf(u), dto);
  }

  @Put('packages/:id')
  @Roles('OWNER', 'MANAGER')
  updatePackage(
    @CurrentUser() u: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReservationPackageInputSchema)) dto: ReservationPackageInput,
  ): Promise<ReservationPackageView> {
    return this.catalog.updatePackage(actorOf(u), id, dto);
  }

  @Patch('packages/:id')
  @Roles('OWNER', 'MANAGER')
  setPackageActive(
    @CurrentUser() u: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReservationPackageActiveSchema)) dto: { active: boolean },
  ): Promise<ReservationPackageView> {
    return this.catalog.setPackageActive(actorOf(u), id, dto.active);
  }

  @Get('settings')
  @Roles('OWNER', 'MANAGER')
  settings(@CurrentUser() u: JwtPayload): Promise<ReservationSettingsView> {
    return this.catalog.settings(u.tenantId);
  }

  /** El enlace web (solo el dueño) y la hora de apertura (dueño o encargado). */
  @Patch('settings')
  @Roles('OWNER', 'MANAGER')
  async updateSettings(
    @CurrentUser() u: JwtPayload,
    @Body(new ZodValidationPipe(ReservationSettingsSchema)) dto: { enabled?: boolean; openTime?: string },
  ): Promise<ReservationSettingsView> {
    if (dto.enabled !== undefined && u.role !== 'OWNER') throw new ForbiddenException('El enlace web lo enciende el dueño');
    if (dto.openTime !== undefined) await this.catalog.setOpenTime(actorOf(u), dto.openTime);
    return dto.enabled !== undefined ? this.catalog.setEnabled(actorOf(u), dto.enabled) : this.catalog.settings(u.tenantId);
  }

  @Get('accounting')
  @Roles('OWNER', 'MANAGER')
  accounting(@CurrentUser() u: JwtPayload, @Query('from') from: string, @Query('to') to: string): Promise<ReservationAccounting> {
    return this.catalog.accounting(actorOf(u), from, to);
  }

  /** El dueño o el encargado reservan para un cliente (vendido por: el panel). */
  @Post()
  @Roles('OWNER', 'MANAGER')
  async book(
    @CurrentUser() u: JwtPayload,
    @Body(new ZodValidationPipe(CreateReservationSchema)) dto: CreateReservationDto,
  ): Promise<{ reservation: ReservationView; link: string }> {
    const entry = await this.reservations.entryForPanel(u.tenantId);
    const created = await this.reservations.book(entry, dto, u.sub);
    // El enlace para mandárselo al cliente: desde ahí paga la señal o todo.
    return { reservation: await this.ops.detail(actorOf(u), created.id), link: `${this.catalog.origin}/reservas/${created.manageToken}` };
  }

  // ─── La noche y la puerta ───────────────────────────────────────────

  @Get()
  @Roles('OWNER', 'MANAGER', 'WAITER')
  night(@CurrentUser() u: JwtPayload, @Query('night', new ZodValidationPipe(DayQuery)) night?: string): Promise<ReservationView[]> {
    return this.ops.night(actorOf(u), night);
  }

  @Get('overdue')
  @Roles('OWNER', 'MANAGER')
  overdue(@CurrentUser() u: JwtPayload): Promise<ReservationView[]> {
    return this.ops.overdue(actorOf(u));
  }

  @Post('scan')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'reservation-scan' })
  scan(@CurrentUser() u: JwtPayload, @Body(new ZodValidationPipe(GuestQuery)) dto: { qr: string }) {
    return this.ops.byGuest(actorOf(u), dto.qr);
  }

  @Get(':id')
  @Roles('OWNER', 'MANAGER', 'WAITER')
  detail(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<ReservationView> {
    return this.ops.detail(actorOf(u), id);
  }

  @Patch(':id/table')
  @Roles('OWNER', 'MANAGER', 'WAITER')
  setTable(
    @CurrentUser() u: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReservationTableSchema)) dto: { tableLabel: string | null },
  ): Promise<ReservationView> {
    return this.ops.setTable(actorOf(u), id, dto.tableLabel);
  }

  @Post(':id/arrive')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  arrive(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ArriveSchema)) dto: { guestId?: string }): Promise<ReservationView> {
    return this.ops.arrive(actorOf(u), id, dto.guestId);
  }

  @Post(':id/rest')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  collectRest(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<{ payUrl: string; payToken: string }> {
    return this.ops.collectRest(actorOf(u), id);
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  noShow(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<ReservationView> {
    return this.ops.noShow(actorOf(u), id);
  }

  @Post(':id/no-show/undo')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  undoNoShow(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<ReservationView> {
    return this.ops.undoNoShow(actorOf(u), id);
  }

  /** El resto en efectivo: cuánto (con la comisión del servicio) y si quien lo pide puede cobrarlo. */
  @Get(':id/rest-cash')
  @Roles('OWNER', 'MANAGER', 'WAITER')
  cashQuote(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string): Promise<ReservationCashQuote> {
    return this.ops.cashQuote(actorOf(u), id);
  }

  @Post(':id/rest-cash')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  payRestCash(
    @CurrentUser() u: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReservationCashSchema)) dto: { key: string; serviceFeeCents: number },
  ): Promise<ReservationView> {
    return this.ops.payRestCash(actorOf(u), id, dto);
  }

  @Post(':id/date')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  venueChangeDate(
    @CurrentUser() u: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ReservationChangeDateSchema)) dto: { nightDate: string },
  ): Promise<ReservationView> {
    return this.ops.venueChangeDate(actorOf(u), id, dto.nightDate);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER')
  venueCancel(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReservationVenueCancelSchema)) dto: { reason: string }) {
    return this.ops.venueCancel(actorOf(u), id, dto.reason);
  }

  // ─── La barra ───────────────────────────────────────────────────────

  @Post('charge')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  charge(@CurrentUser() u: JwtPayload, @Body(new ZodValidationPipe(ReservationChargeSchema)) dto: { guestToken: string; amountCents: number; key: string }): Promise<ReservationView> {
    return this.ops.charge(actorOf(u), dto);
  }

  @Post('serve')
  @HttpCode(200)
  @Roles('OWNER', 'MANAGER', 'WAITER')
  serve(@CurrentUser() u: JwtPayload, @Body(new ZodValidationPipe(ReservationServeSchema)) dto: { guestToken: string; itemName: string; qty: number; key: string }): Promise<ReservationView> {
    return this.ops.serve(actorOf(u), dto);
  }
}
