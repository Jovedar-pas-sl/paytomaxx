import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SetYavinKeyDto, SetYavinUseDto, StepUpWithReasonDto, YavinVenueStatus } from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { baseGatewayOf } from '../gateways/card-gateway';
import { sealYavinKey } from '../gateways/yavin-credential';
import { YAVIN_LINK_TTL_HOURS } from '../gateways/yavin.adapter';
import { yavinEnabled } from '../gateways/yavin-flag';
import { SuperAdminStepUpService } from './step-up.service';
import { SuperAdminAuditService } from './superadmin-audit.service';
import type { SuperAdminActor } from './superadmin.guard';

/** El enlace de Yavin vive 72 h. */
const YAVIN_LINK_TTL_MS = YAVIN_LINK_TTL_HOURS * 60 * 60 * 1000;
/** Cobros que aún pueden acabar pagados (o comprobarse) con el enlace de Yavin. */
const OPEN_PAYMENT_STATUSES = ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN'] as const;

export const YAVIN_KEY_ROTATION_BUSY =
  'Ya cambiaste la clave de Yavin hace poco y las dos últimas tienen enlaces de las últimas 72 h o cobros abiertos: sin ellas no se podrían comprobar, anular ni devolver. Espera a que caduquen para cambiarla otra vez.';

/**
 * ¿La clave guardada en `from` (hasta `until`, cuando la sustituyó otra) abrió
 * enlaces de Yavin de las últimas 72 h, o de cobros aún abiertos?
 */
async function yavinKeyStillNeeded(tx: TransactionalClient, venueId: string, from: Date, until: Date, now: Date): Promise<boolean> {
  const count = await tx.paymentAttempt.count({
    where: {
      tenantId: venueId,
      provider: 'YAVIN',
      createdAt: { gte: from, lt: until },
      OR: [{ createdAt: { gt: new Date(now.getTime() - YAVIN_LINK_TTL_MS) } }, { payment: { status: { in: [...OPEN_PAYMENT_STATUSES] } } }],
    },
  });
  return count > 0;
}

/**
 * Yavin en un local, desde la consola del super-admin (2FA en todo, como el
 * IBAN de liquidación). La clave de API se guarda cifrada en
 * gateway_credentials (provider YAVIN) y nunca vuelve: ni en la respuesta, ni
 * en el registro, ni en el log. Guardar una nueva deja la anterior inactiva
 * (para los enlaces que ya abrió).
 * «Quitar» no la borra: la deja inactiva (ningún cobro nuevo la usa) para que
 * los cobros ya hechos con Yavin se sigan comprobando, anulando y devolviendo.
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
      // La de antes se queda inactiva: los enlaces que abrió (viven 72 h) se
      // siguen comprobando, anulando y devolviendo con ella. Cabe una activa y
      // una inactiva por local: la inactiva más vieja solo se borra si ya no
      // tiene enlaces de las últimas 72 h ni cobros abiertos.
      const rows = await tx.gatewayCredential.findMany({
        where: { tenantId: venueId, provider: 'YAVIN' },
        select: { id: true, active: true, createdAt: true },
      });
      const active = rows.find((row) => row.active);
      const inactive = rows.find((row) => !row.active);
      const now = new Date();
      if (active) {
        const inactiveNeeded = inactive ? await yavinKeyStillNeeded(tx, venueId, inactive.createdAt, active.createdAt, now) : false;
        if (!inactiveNeeded) {
          if (inactive) await tx.gatewayCredential.delete({ where: { id: inactive.id } });
          await tx.gatewayCredential.update({ where: { id: active.id }, data: { active: false } });
        } else if (await yavinKeyStillNeeded(tx, venueId, active.createdAt, now, now)) {
          throw new ConflictException(YAVIN_KEY_ROTATION_BUSY);
        } else {
          // La activa no abrió ningún enlace que siga vivo (p. ej. una clave mal copiada): se sustituye.
          await tx.gatewayCredential.delete({ where: { id: active.id } });
        }
      }
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

  /**
   * Deja de usar Yavin en el local para cobros NUEVOS (2FA y motivo). La clave
   * cifrada se queda guardada pero inactiva: sin ella no se podrían comprobar,
   * anular ni devolver los cobros ya hechos con Yavin. Para cobrar otra vez con
   * Yavin hay que volver a guardar la clave.
   */
  async clear(actor: SuperAdminActor, venueId: string, dto: StepUpWithReasonDto): Promise<YavinVenueStatus> {
    await this.stepUp.verify(actor, dto.totpCode, 'venue.yavin_clear');
    const before = await this.status(venueId);
    if (!before.configured && !before.selected) throw new ConflictException('Este local no tiene Yavin');
    await this.prisma.acrossVenues(async (tx) => {
      if (before.configured) {
        // Solo cabe una inactiva por local (la guardada antes que esta, ya sustituida).
        await tx.gatewayCredential.deleteMany({ where: { tenantId: venueId, provider: 'YAVIN', active: false } });
        await tx.gatewayCredential.updateMany({ where: { tenantId: venueId, provider: 'YAVIN', active: true }, data: { active: false } });
      }
      await tx.venue.update({ where: { id: venueId }, data: { yavinSelected: false } });
    });
    await this.audit.write(actor, {
      action: 'venue.yavin_cleared',
      tenantId: venueId,
      targetType: 'Venue',
      targetId: venueId,
      before: { configured: before.configured, selected: before.selected },
      after: { configured: false, selected: false, keyKeptForExisting: before.configured },
      reason: dto.reason,
    });
    return this.status(venueId);
  }
}
