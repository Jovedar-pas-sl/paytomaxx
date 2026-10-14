import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Prisma } from '@nightpay/db';
import { BRAND_NAME } from '../../common/brand';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { deviceTokenHash, newDeviceToken, relyingParty } from './client-device';
import { sameWalletGroup } from './wallet-rules';

/** Lo que tarda el cliente en mirar el móvil y poner la cara o el dedo. */
const CHALLENGE_TTL_S = 300;
/** lastSeenAt como mucho una vez por hora (la página consulta cada 3 s). */
const SEEN_EVERY_MS = 60 * 60 * 1000;

/** El saldo y el móvil que lo mira. */
export interface DeviceWalletState {
  /** El saldo es de este móvil. */
  thisPhone: boolean;
  /** El saldo es de otro móvil (este solo lo está mirando con el enlace). */
  otherPhone: boolean;
  /** Para aceptar cobros o pedir la devolución hace falta Face ID / huella. */
  protected: boolean;
}

interface WalletRef {
  id: string;
  deviceId: string | null;
}

/**
 * El móvil del cliente (ver client-device.ts) y su Face ID / huella. La llave
 * de Face ID es del móvil, no del saldo: otra noche, con un saldo nuevo, no
 * hay que volver a activarla. Un saldo protegido solo se gasta con la cara o
 * la huella de su móvil, aunque alguien tenga su enlace.
 */
@Injectable()
export class ClientDevicesService {
  private readonly logger = new Logger(ClientDevicesService.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(REDIS_CLIENT) redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;
  }

  // ─── El móvil ──────────────────────────────────────────────────────────

  /** El móvil de esta llave, o null si no la trae o no es nuestra. */
  async find(token: string | null): Promise<{ id: string } | null> {
    if (!token) return null;
    const device = await this.prisma.clientDevice.findUnique({
      where: { tokenHash: deviceTokenHash(token) },
      select: { id: true, lastSeenAt: true },
    });
    if (!device) return null;
    if (Date.now() - device.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await this.prisma.clientDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
    }
    return { id: device.id };
  }

  /** El móvil de esta llave o uno nuevo; newToken es la llave que hay que darle. */
  async findOrCreate(token: string | null): Promise<{ id: string; newToken: string | null }> {
    const found = await this.find(token);
    if (found) return { id: found.id, newToken: null };
    const newToken = newDeviceToken();
    const device = await this.prisma.clientDevice.create({
      data: { tokenHash: deviceTokenHash(newToken) },
      select: { id: true },
    });
    return { id: device.id, newToken };
  }

  /** El saldo de este enlace (solo lo que hace falta aquí). */
  async walletByToken(qrToken: string): Promise<WalletRef> {
    const wallet = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { qrToken }, select: { id: true, deviceId: true } }),
    );
    if (!wallet) throw new NotFoundException('Saldo no encontrado');
    return wallet;
  }

  /**
   * La página, ya abierta en un navegador de verdad, pide el saldo para este
   * móvil (POST /w/:token/claim). No se hace al abrir el enlace: las vistas
   * previas de WhatsApp o iMessage lo abren sin ser el cliente y se lo
   * quedarían. Solo se crea el móvil si el saldo aún no es de nadie.
   */
  async claimForViewer(
    wallet: WalletRef,
    token: string | null,
  ): Promise<{ wallet: WalletRef; viewerId: string | null; newToken: string | null }> {
    if (wallet.deviceId) {
      const viewer = await this.find(token);
      return { wallet, viewerId: viewer?.id ?? null, newToken: null };
    }
    const viewer = await this.findOrCreate(token);
    return { wallet: await this.claim(wallet, viewer.id), viewerId: viewer.id, newToken: viewer.newToken };
  }

  /** El primer móvil que lo pide se lo queda; devuelve el dueño. */
  async claim(wallet: WalletRef, deviceId: string): Promise<WalletRef> {
    if (wallet.deviceId) return wallet;
    const res = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.updateMany({ where: { id: wallet.id, deviceId: null }, data: { deviceId } }),
    );
    // Si otro móvil lo abrió a la vez, gana el primero.
    return res.count > 0 ? { ...wallet, deviceId } : this.walletById(wallet.id);
  }

  async stateFor(wallet: WalletRef, viewerId: string | null): Promise<DeviceWalletState> {
    const owner = wallet.deviceId;
    const keys = owner ? await this.prisma.clientDevicePasskey.count({ where: { deviceId: owner } }) : 0;
    return {
      thisPhone: owner !== null && owner === viewerId,
      otherPhone: owner !== null && owner !== viewerId,
      protected: keys > 0,
    };
  }

  /** /w sin enlace: el saldo abierto más reciente de este móvil. */
  async latestWalletToken(deviceId: string): Promise<string | null> {
    for (const status of ['ACTIVE', 'DEPLETED'] as const) {
      const w = await this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findFirst({
          where: { deviceId, status },
          orderBy: { createdAt: 'desc' },
          select: { qrToken: true },
        }),
      );
      if (w) return w.qrToken;
    }
    return null;
  }

  /** Saldo de este móvil que vale en el local de este cobro (mismo local o grupo). */
  async balanceForPayment(deviceId: string, payToken: string): Promise<number | null> {
    const pay = await this.prisma.acrossVenues((tx) =>
      tx.payment.findUnique({ where: { qrToken: payToken }, select: { tenantId: true } }),
    );
    if (!pay) return null;
    const venue = await this.prisma.venue.findUnique({
      where: { id: pay.tenantId },
      select: { id: true, walletGroup: true },
    });
    if (!venue) return null;
    const wallets = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findMany({
        where: { deviceId, status: 'ACTIVE', balanceCents: { gt: 0 } },
        orderBy: { createdAt: 'desc' },
        select: { tenantId: true, walletGroup: true, balanceCents: true },
      }),
    );
    return wallets.find((w) => sameWalletGroup(w, venue))?.balanceCents ?? null;
  }

  // ─── Face ID / huella (WebAuthn) ───────────────────────────────────────

  /** Paso 1 de activarlo: solo desde el móvil del saldo. */
  async registrationOptions(
    wallet: WalletRef,
    viewerId: string | null,
    host: string | undefined,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const deviceId = this.ownerOrThrow(wallet, viewerId);
    await this.assertNoKeyYet(deviceId);
    const options = await generateRegistrationOptions({
      rpName: BRAND_NAME,
      rpID: this.rp(host).rpID,
      userName: `Saldo ${BRAND_NAME}`,
      userDisplayName: `Saldo ${BRAND_NAME}`,
      // El mismo usuario para el móvil: si lo vuelve a activar, se sustituye.
      userID: new TextEncoder().encode(deviceId),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      preferredAuthenticatorType: 'localDevice',
    });
    await this.redis.set(regKey(deviceId), options.challenge, 'EX', CHALLENGE_TTL_S);
    return options;
  }

  /** Paso 2: comprueba la respuesta del móvil y guarda su clave pública. */
  async register(wallet: WalletRef, viewerId: string | null, host: string | undefined, response: unknown): Promise<void> {
    const deviceId = this.ownerOrThrow(wallet, viewerId);
    await this.assertNoKeyYet(deviceId);
    const expectedChallenge = await this.takeChallenge(regKey(deviceId));
    if (!expectedChallenge) throw new ConflictException('Ha tardado demasiado: vuelve a intentarlo');
    const rp = this.rp(host);
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const v = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpIDs,
        requireUserVerification: true,
      });
      info = v.verified ? v.registrationInfo : undefined;
    } catch (err) {
      this.logger.warn(`passkey register rejected: ${(err as Error).message}`);
    }
    if (!info) throw new ForbiddenException('No se ha podido activar Face ID / huella');
    const c = info.credential;
    try {
      await this.prisma.clientDevicePasskey.create({
        data: {
          deviceId,
          credentialId: c.id,
          publicKey: Buffer.from(c.publicKey),
          counter: BigInt(c.counter),
          transports: c.transports ?? [],
        },
      });
    } catch (err) {
      // La misma llave dos veces (doble toque): ya está.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }

  /** Antes de aceptar un cobro o pedir la devolución: el reto para la cara o el dedo. */
  async challenge(wallet: WalletRef, host: string | undefined): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const keys = wallet.deviceId ? await this.passkeysOf(wallet.deviceId) : [];
    if (keys.length === 0) throw new ConflictException('Este saldo no tiene Face ID / huella');
    const options = await generateAuthenticationOptions({
      rpID: this.rp(host).rpID,
      allowCredentials: keys.map((c) => ({ id: c.credentialId, transports: c.transports })),
      userVerification: 'required',
    });
    // Un hueco por reto (no uno por saldo): pedir retos con el enlace no pisa
    // el que el dueño está usando.
    await this.redis.set(authKey(wallet.id, options.challenge), '1', 'EX', CHALLENGE_TTL_S);
    return options;
  }

  /**
   * Si el saldo está protegido, la acción necesita la cara o la huella de su
   * móvil (vale desde otro aparato del cliente si su llave está sincronizada,
   * p. ej. su iCloud). Sin protección, no cambia nada.
   */
  async assertPresence(wallet: WalletRef, host: string | undefined, response: unknown): Promise<void> {
    const keys = wallet.deviceId ? await this.passkeysOf(wallet.deviceId) : [];
    if (keys.length === 0) return;
    const r = response as AuthenticationResponseJSON | undefined;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') {
      throw new ForbiddenException('Confirma con Face ID o huella');
    }
    const key = keys.find((c) => c.credentialId === r.id);
    if (!key) throw new ForbiddenException('Esa cara o huella no es la de este saldo');
    const expectedChallenge = challengeOf(r);
    const slot = expectedChallenge ? authKey(wallet.id, expectedChallenge) : null;
    if (!slot || (await this.redis.exists(slot)) === 0) {
      throw new ConflictException('Ha tardado demasiado: vuelve a pulsar');
    }
    const rp = this.rp(host);
    let newCounter: number | null = null;
    try {
      const v = await verifyAuthenticationResponse({
        response: r,
        expectedChallenge: expectedChallenge!,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpIDs,
        credential: {
          id: key.credentialId,
          publicKey: new Uint8Array(key.publicKey),
          counter: Number(key.counter),
          transports: key.transports,
        },
        requireUserVerification: true,
      });
      if (v.verified) newCounter = v.authenticationInfo.newCounter;
    } catch (err) {
      this.logger.warn(`passkey assertion rejected wallet=${wallet.id}: ${(err as Error).message}`);
    }
    if (newCounter === null) throw new ForbiddenException('No se ha podido comprobar Face ID / huella');
    // El reto se gasta solo con una firma buena del dueño (la basura no lo
    // gasta); si dos peticiones traen la misma firma, solo pasa la primera.
    if ((await this.redis.del(slot)) !== 1) throw new ConflictException('Esta confirmación ya se usó');
    await this.prisma.clientDevicePasskey.update({
      where: { credentialId: key.credentialId },
      data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
    });
  }

  // ─── Ayudas ────────────────────────────────────────────────────────────

  private async assertNoKeyYet(deviceId: string): Promise<void> {
    if ((await this.prisma.clientDevicePasskey.count({ where: { deviceId } })) > 0) {
      throw new ConflictException('Tu saldo ya está protegido con Face ID / huella');
    }
  }

  private ownerOrThrow(wallet: WalletRef, viewerId: string | null): string {
    if (!viewerId || wallet.deviceId !== viewerId) {
      throw new ForbiddenException('Face ID / huella se activa desde el móvil donde está tu saldo');
    }
    return viewerId;
  }

  private async walletById(id: string): Promise<WalletRef> {
    const w = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id }, select: { id: true, deviceId: true } }),
    );
    if (!w) throw new NotFoundException('Saldo no encontrado');
    return w;
  }

  private async passkeysOf(
    deviceId: string,
  ): Promise<Array<{ credentialId: string; publicKey: Uint8Array; counter: bigint; transports: string[] }>> {
    return this.prisma.clientDevicePasskey.findMany({
      where: { deviceId },
      select: { credentialId: true, publicKey: true, counter: true, transports: true },
    });
  }

  /** Un reto solo vale una vez (se lee y se borra a la vez). */
  private async takeChallenge(key: string): Promise<string | null> {
    const res = await this.redis.multi().get(key).del(key).exec();
    const value = res?.[0]?.[1];
    return typeof value === 'string' ? value : null;
  }

  private rp(host: string | undefined): { rpID: string; rpIDs: string[]; origins: string[] } {
    const { rpID, origins } = relyingParty(host, {
      apiUrl: process.env.NEXT_PUBLIC_API_URL,
      webClientUrl: process.env.NEXT_PUBLIC_WEB_CLIENT_URL,
      production: process.env.NODE_ENV === 'production',
    });
    return { rpID, origins, rpIDs: [...new Set(origins.map((o) => new URL(o).hostname))] };
  }
}

const regKey = (deviceId: string): string => `np:pk:reg:${deviceId}`;
const authKey = (walletId: string, challenge: string): string => `np:pk:auth:${walletId}:${challenge}`;

/** El reto que firmó el móvil (va dentro de clientDataJSON). */
function challengeOf(r: AuthenticationResponseJSON): string | null {
  try {
    const data = JSON.parse(Buffer.from(r.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof data.challenge === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(data.challenge) ? data.challenge : null;
  } catch {
    return null;
  }
}
