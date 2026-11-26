import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SetYavinKeyDto, SetYavinUseDto, StepUpWithReasonDto, YavinVenueStatus } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { baseGatewayOf } from '../gateways/card-gateway';
import { sealYavinKey } from '../gateways/yavin-credential';
import { yavinEnabled } from '../gateways/yavin-flag';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

/**
 * Yavin en un local, desde la consola del super-admin (2FA en todo, como el
 * IBAN de liquidación). La clave de API se guarda cifrada en
 * gateway_credentials (provider YAVIN) y nunca vuelve: ni en la respuesta, ni
 * en el registro, ni en el log. Guardar una nueva sustituye a la anterior.
 */
@Injectable()
export class SuperAdminYavinService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(SuperAdminStepUpService) private readonly stepUp: SuperAdminStepUpService,
    @Inject(SuperAdminAuditService) private readonly audit: SuperAdminAuditService,
  ) {}

  async status(venueId: string): Promise<YavinVenueStatus> {
    return this.prisma.acrossVenues(async (tx) => {
      const venue = await tx.venue.findFirst({ where: { id: venueId, deletedAt: null }, select: { yavinSelected: true } });
      if (!venue) throw new NotFoundException('Local no encontrado');
      const credential = await tx.gatewayCredential.findFirst({
        where: { tenantId: venueId, provider: 'YAVIN', active: true },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      return {
        configured: credential !== null,
        savedAt: credential?.createdAt.toISOString() ?? null,
        selected: venue.yavinSelected,
        inUse: yavinEnabled() && venue.yavinSelected && credential !== null,
        baseGateway: await baseGatewayOf(tx, venueId),
      };
    });
  }

  /** Guarda (o cambia) la clave de Yavin del local, cifrada (2FA). */
  async setKey(actor: SuperAdminActor, venueId: string, dto: SetYavinKeyDto): Promise<YavinVenueStatus> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.yavin_key');
    const before = await this.status(venueId);
    const sealed = sealYavinKey(this.config.get<string>('ENCRYPTION_KEK'), venueId, dto.apiKey);
    await this.prisma.acrossVenues(async (tx) => {
      // Una sola fila de Yavin por local (la de antes se borra: su clave ya no vale).
      await tx.gatewayCredential.deleteMany({ where: { tenantId: venueId, provider: 'YAVIN' } });
      await tx.gatewayCredential.create({ data: { tenantId: venueId, provider: 'YAVIN', active: true, ...sealed } });
    });
    await this.audit.write(actor, {
      action: 'venue.yavin_key_set',
      tenantId: venueId,
      targetType: 'Venue',
      targetId: venueId,
      before: { configured: before.configured },
      after: { configured: true },
    });
    return this.status(venueId);
  }

  /** Usar Yavin en el local (o dejar de usarlo) (2FA). Para usarlo hace falta la clave. */
  async setUse(actor: SuperAdminActor, venueId: string, dto: SetYavinUseDto): Promise<YavinVenueStatus> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.yavin_use');
    const before = await this.status(venueId);
    if (dto.use && !before.configured) throw new ConflictException('Antes de usar Yavin, guarda la clave de API de Yavin del local');
    await this.prisma.acrossVenues((tx) => tx.venue.update({ where: { id: venueId }, data: { yavinSelected: dto.use } }));
    await this.audit.write(actor, {
      action: dto.use ? 'venue.yavin_selected' : 'venue.yavin_unselected',
      tenantId: venueId,
      targetType: 'Venue',
      targetId: venueId,
      before: { selected: before.selected },
      after: { selected: dto.use },
    });
    return this.status(venueId);
  }

  /** Quita la clave y deja de usar Yavin (2FA y motivo). Los cobros ya abiertos siguen su curso. */
  async clear(actor: SuperAdminActor, venueId: string, dto: StepUpWithReasonDto): Promise<YavinVenueStatus> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.yavin_clear');
    const before = await this.status(venueId);
    if (!before.configured && !before.selected) throw new ConflictException('Este local no tiene Yavin');
    await this.prisma.acrossVenues(async (tx) => {
      await tx.gatewayCredential.deleteMany({ where: { tenantId: venueId, provider: 'YAVIN' } });
      await tx.venue.update({ where: { id: venueId }, data: { yavinSelected: false } });
    });
    await this.audit.write(actor, {
      action: 'venue.yavin_cleared',
      tenantId: venueId,
      targetType: 'Venue',
      targetId: venueId,
      before: { configured: before.configured, selected: before.selected },
      after: { configured: false, selected: false },
      reason: dto.reason,
    });
    return this.status(venueId);
  }
}
