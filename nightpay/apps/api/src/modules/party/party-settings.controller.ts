import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { UpdatePartySettingsSchema, type JwtPayload, type PartySettings, type UpdatePartySettingsDto } from '@nightpay/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { PARTY_SETTINGS_SELECT, partySettingsView, planPartySettingsChange } from './party-settings';
import { PartyEditionGuard } from './party-edition.guard';

/**
 * Ajustes de la fiesta (OxioParty; con EDITION=club, 404):
 *  - GET   /v1/admin/party/settings  las fechas, el plazo de devolución, si se dona y el umbral de efectivo.
 *  - PATCH /v1/admin/party/settings  solo el dueño; con la 2FA activada, el código (son reglas del dinero).
 * Con el fin ya pasado no hay cobros ni recargas nuevos (423 EVENT_ENDED) y el fin ya no se quita
 * ni se retrasa (409 EVENT_LOCKED, antes de la 2FA): lo demás sí. El cambio queda en el registro.
 */
@Controller('admin/party')
@UseGuards(PartyEditionGuard, RolesGuard)
export class PartySettingsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('settings')
  @Roles('OWNER', 'MANAGER')
  async settings(@CurrentUser() user: JwtPayload): Promise<PartySettings> {
    return partySettingsView(await this.current(user.tenantId));
  }

  @Patch('settings')
  @Roles('OWNER')
  async update(
    @CurrentUser() user: JwtPayload,
    @Body(new ZodValidationPipe(UpdatePartySettingsSchema)) dto: UpdatePartySettingsDto,
  ): Promise<PartySettings> {
    const current = await this.current(user.tenantId);
    const plan = planPartySettingsChange(current, dto);
    // Antes de pedir la 2FA: terminada la fiesta, el fin no se quita ni se retrasa (409 EVENT_LOCKED).
    if (!plan.ok && plan.code) throw new ConflictException({ message: plan.problem, code: plan.code });
    if (!plan.ok) throw new BadRequestException(plan.problem);
    if (Object.keys(plan.change).length === 0) return partySettingsView(current);
    await this.totp.assertIfEnrolledForUser(user.sub, dto.totpCode);
    const updated = await this.prisma.asSystem((tx) =>
      tx.venue.update({ where: { id: user.tenantId }, data: plan.change, select: PARTY_SETTINGS_SELECT }),
    );
    const before = partySettingsView(current);
    const after = partySettingsView(updated);
    const keys = Object.keys(plan.change) as Array<keyof typeof before>;
    await this.audit.log({
      action: 'party.settings.updated',
      tenantId: user.tenantId,
      actorId: user.sub,
      actorEmail: user.email,
      targetType: 'Venue',
      targetId: user.tenantId,
      payload: { before: Object.fromEntries(keys.map((k) => [k, before[k]])), after: Object.fromEntries(keys.map((k) => [k, after[k]])) },
    });
    return after;
  }

  private current(tenantId: string) {
    return this.prisma.asSystem((tx) => tx.venue.findUniqueOrThrow({ where: { id: tenantId }, select: PARTY_SETTINGS_SELECT }));
  }
}
