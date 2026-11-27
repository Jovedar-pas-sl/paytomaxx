import { ConflictException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Redis } from 'ioredis';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { DORMANT_AFTER_MS } from '../partner/auth/partner-key.guard';
import { partnerApiMode } from '../partner/partner-flag';
import { walletReachable } from '../partner/wallet/wallet-reachable';

/**
 * El código del móvil (`OXC1:` + 26 de base32 de Crockford, 130 bits) que la
 * página del saldo enseña en «Pagar o recargar en otro sistema» y que otra
 * plataforma conectada (API de socios) lee para identificar el saldo. En el
 * piloto solo identifica (`grade: 'identify'`): ver el saldo y cargar. Vive
 * 60 s; en Redis solo va su sha256, nunca el código.
 *
 *  - `np:wlive-gen:<saldo>`: la generación del saldo (16 bytes al azar, 120 s,
 *    se alarga con cada código). Un código vale solo con la de ahora.
 *  - `np:wlive:<sha256 del código>`: `{ walletId, gen, grade }`, 60 s.
 *
 * Anular (dropWallet) pone otra generación al azar: todo código anterior de
 * ese saldo muere al momento, sin índice. Nunca se vuelve a una anterior: una
 * generación caducada o perdida no resucita sus códigos.
 */
export const LIVE_CODE_TTL_S = 60;
const GEN_TTL_S = 120;
const LIVE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIVE_CODE_LENGTH = 26;
/** Los permisos con los que una plataforma lee el código: ver el saldo o cargarlo. */
const OFFER_SCOPES = ['wallet:balance', 'wallet:load'] as const;

export type LiveCodeGrade = 'identify';

export interface IssuedLiveCode {
  code: string;
  /** El QR en SVG como `data:` (la página lo pone en un <img>). */
  qr: string;
  expiresIn: number;
}

export interface LiveCodeEntry {
  walletId: string;
  grade: LiveCodeGrade;
}

const genKey = (walletId: string) => `np:wlive-gen:${walletId}`;
const codeKey = (code: string) => `np:wlive:${createHash('sha256').update(code, 'utf8').digest('hex')}`;
const latest = (...dates: Array<Date | null>) => Math.max(...dates.map((d) => d?.getTime() ?? 0));
const randomGen = () => randomBytes(16).toString('hex');

/** `OXC1:` + 26 caracteres al azar (randomInt: sin sesgo). */
export function newLiveCode(): string {
  return `OXC1:${Array.from({ length: LIVE_CODE_LENGTH }, () => LIVE_CODE_ALPHABET[randomInt(LIVE_CODE_ALPHABET.length)]).join('')}`;
}

/** El QR del código (modo alfanumérico), tinta sobre crema como el de la ficha (fichaQrSvg). */
async function liveCodeQr(code: string): Promise<string> {
  const svg = await QRCode.toString([{ data: code, mode: 'alphanumeric' }], {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#1f2c36', light: '#efe9df' },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

const tryLater = () =>
  new ServiceUnavailableException({ message: 'Ahora no podemos darte el código. Prueba otra vez en un momento.', code: 'TRY_LATER' });

@Injectable()
export class WalletLiveCodeService {
  private readonly logger = new Logger(WalletLiveCodeService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  /**
   * Un código nuevo del saldo. Uno sumado a otro no da código (409
   * WALLET_CLOSED, sin tocar Redis): el enlace de una recarga sumada no tiene
   * Face ID y su código daría el saldo de destino. Uno cerrado sí: quien lo lee
   * recibe `409 wallet_closed`. Sin Redis, 503 TRY_LATER.
   */
  async issue(walletId: string): Promise<IssuedLiveCode> {
    const wallet = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findUnique({ where: { id: walletId }, select: { mergedIntoId: true } }),
    );
    if (!wallet || wallet.mergedIntoId) {
      throw new ConflictException({ message: 'Este saldo se ha sumado a otro: usa el enlace de ese.', code: 'WALLET_CLOSED' });
    }
    const redis = this.redis;
    if (!redis) throw tryLater();
    const code = newLiveCode();
    try {
      await redis.set(genKey(walletId), randomGen(), 'EX', GEN_TTL_S, 'NX');
      let gen = await redis.get(genKey(walletId));
      if (!gen) {
        // Caducó justo entre las dos órdenes: una nueva (nunca una anterior).
        gen = randomGen();
        await redis.set(genKey(walletId), gen, 'EX', GEN_TTL_S);
      } else {
        await redis.expire(genKey(walletId), GEN_TTL_S);
      }
      const entry = JSON.stringify({ walletId, gen, grade: 'identify' satisfies LiveCodeGrade });
      await redis.set(codeKey(code), entry, 'EX', LIVE_CODE_TTL_S);
    } catch (err) {
      this.logger.warn(`Código del móvil sin dar: Redis no responde (${(err as Error).message})`);
      throw tryLater();
    }
    return { code, qr: await liveCodeQr(code), expiresIn: LIVE_CODE_TTL_S };
  }

  /**
   * ¿Sale «Pagar o recargar en otro sistema» en la página de este saldo? Solo
   * si alguna conexión que hoy vale (ACTIVE, de socio ACTIVE, sin dormir ni
   * caducar, del modo de este despliegue y con su local, no borrado, en la
   * sociedad con la que se conectó y con NIF: lo que pide PartnerKeyGuard) tiene `wallet:balance` o `wallet:load` (dentro del techo
   * del socio) y alcanza el saldo (walletReachable, como POST /wallet/balance).
   * Un permiso útil en pausa (pausedScopes) no cuenta. Un saldo sumado a otro
   * o bloqueado, nunca. Lecturas cruzadas: en asSystem. Nunca lanza: si falla,
   * no sale (con un aviso en el log, solo el tipo del error).
   */
  async offered(walletId: string, now: Date = new Date()): Promise<boolean> {
    try {
      return await this.isOffered(walletId, now);
    } catch (err) {
      this.logger.warn(`«Pagar o recargar en otro sistema» sin mirar: la página sale sin él (${(err as Error).name})`);
      return false;
    }
  }

  private async isOffered(walletId: string, now: Date): Promise<boolean> {
    const mode = partnerApiMode();
    if (!mode) return false;
    return this.prisma.asSystem(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({
        where: { id: walletId },
        select: { tenantId: true, walletGroup: true, mergedIntoId: true, blockedAt: true },
      });
      if (!wallet || wallet.mergedIntoId || wallet.blockedAt) return false;
      const home = await tx.venue.findUnique({ where: { id: wallet.tenantId }, select: { businessId: true } });
      if (!home?.businessId) return false;
      const conns = await tx.partnerConnection.findMany({
        where: {
          status: 'ACTIVE',
          keyMode: mode,
          businessId: home.businessId,
          keySuspendedAt: null,
          OR: [{ keyExpiresAt: null }, { keyExpiresAt: { gt: now } }],
          scopes: { hasSome: [...OFFER_SCOPES] },
          partner: { status: 'ACTIVE' },
          venue: { deletedAt: null, businessId: home.businessId },
        },
        select: {
          tenantId: true,
          scopes: true,
          pausedScopes: true,
          keyCreatedAt: true,
          keyResumedAt: true,
          lastUsedAt: true,
          partner: { select: { allowedScopes: true } },
          venue: { select: { walletGroup: true, businessId: true, business: { select: { taxId: true } } } },
        },
      });
      return conns.some(
        (c) =>
          // Su sociedad sin NIF: el guard la pausa (connection_paused).
          Boolean(c.venue.business?.taxId) &&
          // Dormida (90 días sin uso): el guard la duerme al verla; aquí ya no vale.
          now.getTime() - latest(c.keyCreatedAt, c.lastUsedAt, c.keyResumedAt) <= DORMANT_AFTER_MS &&
          OFFER_SCOPES.some((s) => c.scopes.includes(s) && c.partner.allowedScopes.includes(s) && !c.pausedScopes.includes(s)) &&
          walletReachable(wallet, home, { tenantId: c.tenantId, walletGroup: c.venue.walletGroup, businessId: c.venue.businessId }),
      );
    });
  }

  /** De qué saldo es un código vivo, o null (caducado, desconocido o anulado). Sin Redis, lanza. */
  async peek(code: string): Promise<LiveCodeEntry | null> {
    const redis = this.redis;
    if (!redis) throw new Error('Redis no está configurado');
    const raw = await redis.get(codeKey(code));
    if (!raw) return null;
    let entry: { walletId?: unknown; gen?: unknown; grade?: unknown };
    try {
      entry = JSON.parse(raw) as typeof entry;
    } catch {
      return null;
    }
    if (typeof entry.walletId !== 'string' || typeof entry.gen !== 'string' || entry.grade !== 'identify') return null;
    const gen = await redis.get(genKey(entry.walletId));
    if (!gen || gen !== entry.gen) return null;
    return { walletId: entry.walletId, grade: entry.grade };
  }

  /**
   * Anula al momento todo código del saldo (otra generación al azar). Nunca
   * lanza: sin Redis, o si falla, aviso en el log y sus códigos viven sus 60 s.
   */
  async dropWallet(walletId: string): Promise<void> {
    if (!this.redis) {
      this.logger.warn('Códigos del móvil sin anular: no hay Redis (viven sus 60 s)');
      return;
    }
    try {
      await this.redis.set(genKey(walletId), randomGen(), 'EX', GEN_TTL_S);
    } catch (err) {
      this.logger.warn(`Códigos del móvil sin anular (viven sus 60 s): ${(err as Error).message}`);
    }
  }
}
