import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { WalletStatus } from '@nightpay/db';
import { BRAND_NAME } from '../../../common/brand';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { readGoogleWalletConfig, type GoogleWalletSettings } from '../../../config/google-wallet';
import { WalletChargesService } from '../wallet-charges.service';
import { GoogleWalletClient, type FetchFn } from './google-wallet-client';
import { saveToWalletUrl } from './google-wallet-jwt';
import {
  genericClass,
  genericObject,
  linkHash,
  passObjectId,
  revokedObjectPatch,
  type GenericObject,
  type PassWallet,
} from './google-wallet-pass';
import { findDuePasses, syncAction, type DuePass } from './google-wallet-sync';
import { passChargeSecret, passChargeUrl } from './pass-charge-token';

/** Para las pruebas: otro fetch en vez del global. */
export const GOOGLE_WALLET_FETCH = Symbol('GOOGLE_WALLET_FETCH');

/** Sin NEXT_PUBLIC_API_URL (solo en local): el API en su puerto. */
const LOCAL_API_ORIGIN = 'http://localhost:4100';
/** Toques de «Añadir» por saldo y minuto (cada uno llama a Google). */
const SAVE_MAX_PER_MINUTE = 5;
/** Un repaso a la vez aunque haya varias réplicas o uno tarde más de 2 min. */
const SYNC_LOCK_KEY = 'np:google-wallet-sync:lock';
const SYNC_LOCK_MS = 5 * 60 * 1000;
/** Tantos fallos seguidos = Google no responde: el resto, en la próxima vuelta. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Suelta el candado solo si sigue siendo nuestro. */
const RELEASE_LOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface GoogleWalletSyncSummary {
  checked: number;
  updated: number;
  revoked: number;
  failed: number;
}

/** Lo que usa del Redis compartido (candado del repaso y límite por saldo). */
type RedisLike = Pick<Redis, 'set' | 'incr' | 'pexpire' | 'eval'>;

/**
 * Pase del saldo en Google Wallet.
 *  - saveLink: el cliente pulsa «Añadir a Google Wallet» en /w/:token → se
 *    crea (o se pone al día) el pase en Google y se devuelve el enlace para
 *    guardarlo (https://pay.google.com/gp/v/save/<jwt>).
 *  - syncDue: el repaso cada ~2 min (cola google-wallet-sync) pone al día
 *    los pases cuyo saldo o estado cambió, y apaga los de enlaces viejos.
 * Sin configurar (config/google-wallet.ts) no hace nada: `enabled` es false.
 */
@Injectable()
export class GoogleWalletService {
  private readonly logger = new Logger(GoogleWalletService.name);
  private readonly prisma: PrismaService;
  private readonly charges: WalletChargesService;
  private readonly redis: RedisLike;
  private readonly settings: GoogleWalletSettings | null;
  private readonly client: GoogleWalletClient | null;
  private readonly publicOrigin: string;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(REDIS_CLIENT) redis: RedisLike,
    @Optional() @Inject(GOOGLE_WALLET_FETCH) fetchFn?: FetchFn,
  ) {
    this.prisma = prisma;
    this.charges = charges;
    this.redis = redis;
    const read = readGoogleWalletConfig({
      GOOGLE_WALLET_ISSUER_ID: config.get<string>('GOOGLE_WALLET_ISSUER_ID'),
      GOOGLE_WALLET_SERVICE_ACCOUNT_JSON: config.get<string>('GOOGLE_WALLET_SERVICE_ACCOUNT_JSON'),
      GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64: config.get<string>('GOOGLE_WALLET_SERVICE_ACCOUNT_JSON_B64'),
      GOOGLE_WALLET_CLASS_SUFFIX: config.get<string>('GOOGLE_WALLET_CLASS_SUFFIX'),
    });
    this.settings = read.status === 'on' ? read.settings : null;
    this.client = this.settings ? new GoogleWalletClient(this.settings, fetchFn) : null;
    this.publicOrigin = originOf(config.get<string>('NEXT_PUBLIC_API_URL')) ?? LOCAL_API_ORIGIN;
  }

  /** Configurado: el botón sale y el repaso corre. */
  get enabled(): boolean {
    return this.settings !== null;
  }

  /**
   * Enlace para guardar en Google Wallet el pase del saldo de este enlace.
   * Lo mismo que las demás acciones de /w: el enlace es la credencial. El
   * enlace devuelto vale tanto como el de /w (el pase lleva «Ver mi saldo»):
   * solo se le da a quien ya tiene el de /w y no se guarda ni sale en el log.
   */
  async saveLink(qrToken: string): Promise<{ saveUrl: string }> {
    const { settings, client } = this.ready();
    const ref = await this.charges.walletRefByToken(qrToken);
    const wallet = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findUnique({
        where: { id: ref.id },
        select: { qrToken: true, balanceCents: true, status: true, mergedIntoId: true, venue: { select: { name: true } } },
      }),
    );
    if (!wallet) throw new NotFoundException('Saldo no encontrado');
    if (wallet.status !== 'ACTIVE' || wallet.mergedIntoId) {
      throw new ConflictException({ message: 'Este saldo ya está cerrado', code: 'WALLET_CLOSED' });
    }

    const tokenHash = linkHash(wallet.qrToken);
    await this.throttleSave(tokenHash);
    const objectId = passObjectId(settings, tokenHash);
    const passWallet: PassWallet = {
      balanceCents: wallet.balanceCents,
      status: wallet.status,
      merged: false,
      venueName: wallet.venue?.name ?? null,
    };
    try {
      await client.ensureClass(genericClass(settings.classId));
      await client.saveObject(this.passObject(settings, objectId, { id: ref.id, qrToken: wallet.qrToken }, passWallet));
    } catch (err) {
      this.logger.warn(`Google Wallet: no se pudo preparar el pase del saldo ${ref.id}: ${(err as Error).message}`);
      throw new ServiceUnavailableException({ message: 'Google Wallet no responde ahora. Inténtalo en un rato.', code: 'TRY_LATER' });
    }

    // El enlace para guardarlo solo sale si el pase quedó apuntado: así un pase
    // guardado siempre está en el repaso.
    const now = new Date();
    const synced = {
      lastSyncedBalanceCents: wallet.balanceCents,
      lastSyncedStatus: wallet.status,
      lastSyncedAt: now,
      lastAttemptAt: now,
    };
    await this.prisma.walletPass.upsert({
      where: { objectId },
      create: { walletId: ref.id, provider: 'GOOGLE', objectId, tokenHash, ...synced },
      update: { ...synced, revokedAt: null },
    });
    return {
      saveUrl: saveToWalletUrl(settings, { objectId, classId: settings.classId, origins: [this.publicOrigin] }),
    };
  }

  /**
   * El repaso: pone al día los pases que lo necesitan (como mucho un lote).
   * Uno a la vez (candado en Redis); si Google no responde, para y sigue en
   * la próxima vuelta.
   */
  async syncDue(limit?: number): Promise<GoogleWalletSyncSummary> {
    const summary: GoogleWalletSyncSummary = { checked: 0, updated: 0, revoked: 0, failed: 0 };
    if (!this.settings || !this.client) return summary;
    const lock = randomUUID();
    if ((await this.redis.set(SYNC_LOCK_KEY, lock, 'PX', SYNC_LOCK_MS, 'NX')) !== 'OK') {
      this.logger.debug('Google Wallet: ya hay un repaso en marcha');
      return summary;
    }
    try {
      await this.syncBatch(limit, summary);
    } finally {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, SYNC_LOCK_KEY, lock);
    }
    if (summary.checked > 0) {
      this.logger.log(
        `Google Wallet: ${summary.updated} pases al día, ${summary.revoked} apagados, ${summary.failed} con error`,
      );
    }
    return summary;
  }

  private async syncBatch(limit: number | undefined, summary: GoogleWalletSyncSummary): Promise<void> {
    const due = await this.prisma.asSystem((tx) => findDuePasses(tx, limit));
    summary.checked = due.length;
    let failedInARow = 0;
    for (const pass of due) {
      try {
        const done = await this.syncOne(pass);
        if (done === 'update') summary.updated += 1;
        if (done === 'revoke') summary.revoked += 1;
        failedInARow = 0;
      } catch (err) {
        summary.failed += 1;
        failedInARow += 1;
        this.logger.warn(`Google Wallet: no se pudo poner al día el pase ${pass.objectId}: ${(err as Error).message}`);
        await this.markAttempt(pass.id);
        if (failedInARow >= MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn(`Google Wallet: ${failedInARow} fallos seguidos; el resto, en el próximo repaso`);
          return;
        }
      }
    }
  }

  private async syncOne(pass: DuePass): Promise<'update' | 'revoke' | 'skip'> {
    const { settings, client } = this.ready();
    const action = syncAction(pass);
    const now = new Date();
    if (action === 'revoke') {
      await client.patchObject(pass.objectId, revokedObjectPatch());
      await this.prisma.walletPass.update({ where: { id: pass.id }, data: { revokedAt: now, lastAttemptAt: now } });
      return action;
    }
    if (action === 'update') {
      const wallet: PassWallet = {
        balanceCents: pass.balanceCents,
        status: pass.status,
        merged: pass.merged,
        venueName: pass.venueName,
      };
      await client.ensureClass(genericClass(settings.classId));
      // También cambia el QR de los pases hechos cuando era el enlace /w (migración 20261022110000).
      await client.syncObject(this.passObject(settings, pass.objectId, { id: pass.walletId, qrToken: pass.qrToken }, wallet));
      await this.prisma.walletPass.update({
        where: { id: pass.id },
        data: {
          lastSyncedBalanceCents: pass.balanceCents,
          lastSyncedStatus: pass.status as WalletStatus,
          lastSyncedAt: now,
          lastAttemptAt: now,
        },
      });
    }
    return action;
  }

  /** Falló: al final de la cola (sigue pendiente: lo enviado no cambia). */
  private async markAttempt(passId: string): Promise<void> {
    try {
      await this.prisma.walletPass.update({ where: { id: passId }, data: { lastAttemptAt: new Date() } });
    } catch (err) {
      this.logger.warn(`Google Wallet: no se pudo apuntar el intento del pase ${passId}: ${(err as Error).message}`);
    }
  }

  /** Cada toque llama a Google: como mucho unos pocos por saldo y minuto. */
  private async throttleSave(tokenHash: string): Promise<void> {
    const key = `np:google-wallet-save:${tokenHash.slice(0, 32)}`;
    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.pexpire(key, 60_000);
    } catch (err) {
      // Sin Redis no se bloquea al cliente: queda el límite por IP.
      this.logger.warn(`Google Wallet: límite por saldo sin Redis: ${(err as Error).message}`);
      return;
    }
    if (count > SAVE_MAX_PER_MINUTE) {
      throw new HttpException(
        { message: 'Demasiados intentos: espera un minuto y vuelve a probar.', code: 'RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private passObject(
    settings: GoogleWalletSettings,
    objectId: string,
    link: { id: string; qrToken: string },
    wallet: PassWallet,
  ): GenericObject {
    return genericObject({
      objectId,
      classId: settings.classId,
      brand: BRAND_NAME,
      walletUrl: `${this.publicOrigin}/w/${encodeURIComponent(link.qrToken)}`,
      // El QR solo cobra en el datáfono (con el PIN): no abre el saldo.
      chargeUrl: passChargeUrl(this.publicOrigin, passChargeSecret(), link.id, link.qrToken),
      wallet,
    });
  }

  private ready(): { settings: GoogleWalletSettings; client: GoogleWalletClient } {
    if (!this.settings || !this.client) throw new NotFoundException('Google Wallet no está activado');
    return { settings: this.settings, client: this.client };
  }
}

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
