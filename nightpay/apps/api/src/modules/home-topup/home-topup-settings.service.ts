import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import { Prisma } from '@nightpay/db';
import { HOME_TOPUP_PATH_PREFIX, serviceFeeBpsFor, type HomeTopUpSettings } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SELF_TOPUP_MAX_CENTS, SELF_TOPUP_MIN_CENTS } from '../wallets/wallet-topup-rules';
import { homeTopUpProblem, newHomeTopUpCode } from './home-topup-rules';
import { queueToken, queueUrl, queueValidUntil } from './home-topup-queue';

/** El cartel de la cola de esta noche (B16): su enlace, su QR y hasta cuándo vale. */
export interface HomeTopUpQueuePoster {
  url: string;
  qrPngDataUrl: string;
  /** ISO: cuando cambia la noche de /r (las 10:00 UTC). */
  validUntil: string;
}
import { HomeTopUpService } from './home-topup.service';

/** Sin NEXT_PUBLIC_API_URL (solo en local): el API en su puerto. */
const LOCAL_API_ORIGIN = 'http://localhost:4100';
/** Códigos nuevos que se prueban si uno ya lo tiene otro local (96 bits: no pasa). */
const MAX_CODE_ATTEMPTS = 5;

export interface HomeTopUpActor {
  userId: string;
  email?: string;
  tenantId: string;
}

/**
 * Ajustes → Formas de cobro → «Cargar saldo desde casa» (solo el dueño):
 * encender o apagar el enlace del local y «Enlace nuevo». Al encender por
 * primera vez se crea el código; apagar lo conserva (al volver a encender,
 * el mismo enlace). «Enlace nuevo» cambia el código: el de antes da 404. En
 * el registro, quién y qué (nunca el código).
 */
@Injectable()
export class HomeTopUpSettingsService {
  private readonly logger = new Logger(HomeTopUpSettingsService.name);
  private readonly origin: string;
  private readonly secret: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(HomeTopUpService) private readonly homeTopUps: HomeTopUpService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.origin = originOf(config.get<string>('NEXT_PUBLIC_API_URL')) ?? LOCAL_API_ORIGIN;
    this.secret = config.get<string>('COOKIE_SECRET') ?? '';
  }

  /**
   * El cartel de la cola de esta noche (B16): el enlace del local con el QR
   * firmado de esta noche. Con la carga desde casa apagada, null (no hay
   * enlace que poner en el cartel).
   */
  async queuePoster(venueId: string, now: Date = new Date()): Promise<HomeTopUpQueuePoster | null> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { homeTopUpEnabled: true, homeTopUpCode: true } }),
    );
    if (!venue.homeTopUpEnabled || !venue.homeTopUpCode || this.secret.length < 32) return null;
    const url = queueUrl(
      `${this.origin}${HOME_TOPUP_PATH_PREFIX}${venue.homeTopUpCode}`,
      queueToken(this.secret, venueId, venue.homeTopUpCode, now.getTime()),
    );
    return {
      url,
      qrPngDataUrl: await QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' }),
      validUntil: queueValidUntil(now.getTime()).toISOString(),
    };
  }

  async view(venueId: string): Promise<HomeTopUpSettings> {
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { homeTopUpEnabled: true, homeTopUpCode: true } }),
    );
    const state = await this.homeTopUps.venueState(venueId);
    const url = venue.homeTopUpEnabled && venue.homeTopUpCode ? `${this.origin}${HOME_TOPUP_PATH_PREFIX}${venue.homeTopUpCode}` : null;
    return {
      enabled: venue.homeTopUpEnabled,
      url,
      qrPngDataUrl: url ? await QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' }) : null,
      problem: venue.homeTopUpEnabled && state ? homeTopUpProblem(state.state) : null,
      minCents: SELF_TOPUP_MIN_CENTS,
      maxCents: SELF_TOPUP_MAX_CENTS,
      serviceFeeBps: state ? serviceFeeBpsFor(state.serviceFee, 'topUp') : null,
    };
  }

  /** Encender (con su código; el primero se crea ahora) o apagar. */
  async setEnabled(actor: HomeTopUpActor, enabled: boolean): Promise<HomeTopUpSettings> {
    const before = await this.prisma.asSystem((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { homeTopUpEnabled: true, homeTopUpCode: true } }),
    );
    if (enabled && !before.homeTopUpCode) {
      await this.saveNewCode(actor.tenantId, { homeTopUpEnabled: true });
    } else if (before.homeTopUpEnabled !== enabled) {
      await this.prisma.asSystem((tx) =>
        tx.venue.update({ where: { id: actor.tenantId }, data: { homeTopUpEnabled: enabled }, select: { id: true } }),
      );
    }
    if (before.homeTopUpEnabled !== enabled) {
      await this.log(actor, 'venue.home_topup.updated', { before: { enabled: before.homeTopUpEnabled }, after: { enabled } });
    }
    return this.view(actor.tenantId);
  }

  /** «Enlace nuevo»: otro código; el de antes deja de funcionar al momento. */
  async rotate(actor: HomeTopUpActor): Promise<HomeTopUpSettings> {
    await this.saveNewCode(actor.tenantId, {});
    await this.log(actor, 'venue.home_topup.link_rotated', {});
    this.logger.log(`Cargar desde casa: enlace nuevo en el local ${actor.tenantId}`);
    return this.view(actor.tenantId);
  }

  /** Guarda un código nuevo (si chocara con el de otro local, otro). */
  private async saveNewCode(venueId: string, extra: { homeTopUpEnabled?: boolean }): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.asSystem((tx) =>
          tx.venue.update({ where: { id: venueId }, data: { homeTopUpCode: newHomeTopUpCode(), ...extra }, select: { id: true } }),
        );
        return;
      } catch (err) {
        const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!clash || attempt >= MAX_CODE_ATTEMPTS) throw err;
      }
    }
  }

  private log(actor: HomeTopUpActor, action: string, payload: Record<string, unknown>): Promise<void> {
    return this.audit.log({
      action,
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: 'Venue',
      targetId: actor.tenantId,
      payload,
    });
  }
}

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}
