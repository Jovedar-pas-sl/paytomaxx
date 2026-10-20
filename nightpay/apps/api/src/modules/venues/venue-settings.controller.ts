import { BadRequestException, Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  STAFF_PERMISSION_KEYS,
  UpdateAlertSettingsSchema,
  UpdatePaymentMethodsSchema,
  UpdateNightSettingsSchema,
  UpdateStaffPermissionsSchema,
  alertSettingsOf,
  mergeAlertSettings,
  mergeNightSettings,
  mergePaymentMethods,
  mergeStaffPermissions,
  nightSettingsOf,
  nightSettingsProblem,
  paymentMethodsOf,
  staffCan,
  staffPermissionsOf,
  type JwtPayload,
  type PermissionSet,
  type StaffPermissions,
  type UpdateAlertSettingsDto,
  type UpdateNightSettingsDto,
  type UpdatePaymentMethodsDto,
  type UpdateStaffPermissionsDto,
  type VenueAlertSettings,
  type VenueNightSettings,
  type VenuePaymentMethods,
} from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** Persona del local a la que el dueño puede dar o quitar permisos. */
export interface PermissionPerson {
  id: string;
  email: string;
  displayName: string | null;
  role: 'MANAGER' | 'WAITER';
}

export interface AlertSettingsView extends VenueAlertSettings {
  /** Hay bot de Telegram (TELEGRAM_BOT_TOKEN) en el servidor. */
  botConfigured: boolean;
  /** Hay chat por defecto (TELEGRAM_CHAT_ID) para los locales sin chat propio. */
  defaultChatConfigured: boolean;
}

/**
 * Ajustes del dueño (panel → Ajustes):
 *  - GET/PATCH /v1/admin/venue/payment-methods → formas de cobro y propinas.
 *  - GET/PATCH /v1/admin/venue/permissions     → permisos del personal.
 *  - GET       /v1/admin/venue/permissions/me  → lo que puede hacer quien mira.
 *  - GET/PATCH /v1/admin/venue/alerts          → avisos de Telegram («Probar»: POST /v1/incidents/telegram-test).
 *  - GET/PATCH /v1/admin/venue/night           → la noche: NFC sin PIN, teclado del PIN, recepción, avisos al cobrar.
 * Cada cambio queda en el registro (antes y después). Las reglas de dinero
 * (tope, comisiones, espera, aprobaciones) van en PATCH /v1/admin/venue/settings, con 2FA.
 */
@Controller('admin/venue')
@UseGuards(RolesGuard)
export class VenueSettingsController {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly config: ConfigService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.config = config;
  }

  // ─── Formas de cobro ───────────────────────────────────────────────

  /** Todo el personal: las apps esconden lo apagado. */
  @Get('payment-methods')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async paymentMethods(@CurrentUser() user: JwtPayload): Promise<VenuePaymentMethods> {
    return paymentMethodsOf((await this.venueSettings(user.tenantId)).paymentMethods);
  }

  @Patch('payment-methods')
  @Roles('OWNER')
  async updatePaymentMethods(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdatePaymentMethodsSchema)) dto: UpdatePaymentMethodsDto,
  ): Promise<VenuePaymentMethods> {
    const current = (await this.venueSettings(user.tenantId)).paymentMethods;
    const before = paymentMethodsOf(current);
    const after = mergePaymentMethods(current, dto);
    await this.save(user.tenantId, { paymentMethods: after });
    await this.logChange(user, 'venue.payment_methods.updated', before, after);
    return after;
  }

  // ─── Permisos del personal ─────────────────────────────────────────

  @Get('permissions')
  @Roles('OWNER')
  async permissions(@CurrentUser() user: JwtPayload): Promise<{ permissions: StaffPermissions; people: PermissionPerson[] }> {
    const [venue, people] = await Promise.all([this.venueSettings(user.tenantId), this.permissionPeople(user.tenantId)]);
    const permissions = staffPermissionsOf(venue.staffPermissions);
    // Las excepciones de quien ya no está (baja, otro rol) no se enseñan.
    const known = new Set(people.map((p) => p.id));
    const visible = Object.fromEntries(Object.entries(permissions.people).filter(([id]) => known.has(id)));
    return { permissions: { ...permissions, people: visible }, people };
  }

  /** Lo que puede hacer quien mira (el panel esconde lo que no puede usar). */
  @Get('permissions/me')
  @Roles('OWNER', 'MANAGER', 'WAITER')
  async myPermissions(@CurrentUser() user: JwtPayload): Promise<PermissionSet> {
    const perms = staffPermissionsOf((await this.venueSettings(user.tenantId)).staffPermissions);
    const actor = { role: user.role, userId: user.sub };
    return Object.fromEntries(STAFF_PERMISSION_KEYS.map((k) => [k, staffCan(perms, actor, k)])) as PermissionSet;
  }

  @Patch('permissions')
  @Roles('OWNER')
  async updatePermissions(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateStaffPermissionsSchema)) dto: UpdateStaffPermissionsDto,
  ): Promise<StaffPermissions> {
    const ids = Object.keys(dto.people ?? {});
    if (ids.length > 0) {
      const people = new Set((await this.permissionPeople(user.tenantId)).map((p) => p.id));
      const stranger = ids.find((id) => !people.has(id) && dto.people?.[id] !== null);
      if (stranger) throw new BadRequestException('Esa persona no es encargado ni camarero de este local');
    }
    const current = (await this.venueSettings(user.tenantId)).staffPermissions;
    const before = staffPermissionsOf(current);
    const after = mergeStaffPermissions(current, dto);
    await this.save(user.tenantId, { staffPermissions: after });
    await this.logChange(user, 'venue.staff_permissions.updated', before, after);
    return after;
  }

  // ─── Avisos de Telegram ────────────────────────────────────────────

  @Get('alerts')
  @Roles('OWNER')
  async alerts(@CurrentUser() user: JwtPayload): Promise<AlertSettingsView> {
    return this.alertsView(alertSettingsOf((await this.venueSettings(user.tenantId)).alertSettings));
  }

  @Patch('alerts')
  @Roles('OWNER')
  async updateAlerts(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateAlertSettingsSchema)) dto: UpdateAlertSettingsDto,
  ): Promise<AlertSettingsView> {
    const current = (await this.venueSettings(user.tenantId)).alertSettings;
    const before = alertSettingsOf(current);
    const after = mergeAlertSettings(current, dto);
    await this.save(user.tenantId, { alertSettings: after });
    await this.logChange(user, 'venue.alert_settings.updated', before, after);
    return this.alertsView(after);
  }

  // ─── La noche (NFC sin PIN, teclado del PIN, recepción) ─────────────

  /** Todo el personal: las apps los usan (el teclado del PIN, la recepción). También en /v1/venues/me. */
  @Get('night')
  @Roles('OWNER', 'MANAGER', 'WAITER', 'OPERATOR')
  async night(@CurrentUser() user: JwtPayload): Promise<VenueNightSettings> {
    return nightSettingsOf((await this.venueSettings(user.tenantId)).nightSettings);
  }

  @Patch('night')
  @Roles('OWNER')
  async updateNight(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdateNightSettingsSchema)) dto: UpdateNightSettingsDto,
  ): Promise<VenueNightSettings> {
    const current = (await this.venueSettings(user.tenantId)).nightSettings;
    const before = nightSettingsOf(current);
    const after = mergeNightSettings(current, dto);
    const problem = nightSettingsProblem(after);
    if (problem) throw new BadRequestException(problem);
    await this.save(user.tenantId, { nightSettings: after });
    await this.logChange(user, 'venue.night_settings.updated', before, after);
    return after;
  }

  // ─── internos ──────────────────────────────────────────────────────

  private alertsView(settings: VenueAlertSettings): AlertSettingsView {
    return {
      ...settings,
      botConfigured: Boolean(this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim()),
      defaultChatConfigured: Boolean(this.config.get<string>('TELEGRAM_CHAT_ID')?.trim()),
    };
  }

  private venueSettings(tenantId: string) {
    // Venue no va por local en el middleware: id explícito del JWT.
    return this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id: tenantId },
        select: { paymentMethods: true, staffPermissions: true, alertSettings: true, nightSettings: true },
      }),
    );
  }

  private permissionPeople(tenantId: string): Promise<PermissionPerson[]> {
    return this.prisma.asSystem(async (tx) => {
      const rows = await tx.user.findMany({
        where: { tenantId, deletedAt: null, role: { in: ['MANAGER', 'WAITER'] } },
        select: { id: true, email: true, displayName: true, role: true },
        orderBy: [{ role: 'asc' }, { email: 'asc' }],
      });
      return rows.map((r) => ({ ...r, role: r.role as PermissionPerson['role'] }));
    });
  }

  private async save(
    tenantId: string,
    data: {
      paymentMethods?: VenuePaymentMethods;
      staffPermissions?: StaffPermissions;
      alertSettings?: VenueAlertSettings;
      nightSettings?: VenueNightSettings;
    },
  ): Promise<void> {
    await this.prisma.asSystem((tx) =>
      tx.venue.update({ where: { id: tenantId }, data: data as never, select: { id: true } }),
    );
  }

  private logChange(user: JwtPayload, action: string, before: unknown, after: unknown): Promise<void> {
    return this.audit.log({
      action,
      tenantId: user.tenantId,
      actorId: user.sub,
      actorEmail: user.email,
      targetType: 'Venue',
      targetId: user.tenantId,
      payload: { before, after },
    });
  }
}
