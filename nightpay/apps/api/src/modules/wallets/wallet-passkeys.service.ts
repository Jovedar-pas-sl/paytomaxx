import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
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
import { currentRelyingParty } from './passkey-rp';
import { formatWalletCode } from './wallet-rules';

/** Lo que tarda el cliente en mirar el móvil y desbloquearlo. */
const CHALLENGE_TTL_S = 300;

/**
 * La llave del saldo (passkey): el cliente paga desbloqueando su móvil como
 * siempre (Face ID, huella o el PIN del teléfono; lo decide su móvil). Aquí
 * solo la clave pública. Al pagar, su móvil elige la llave (sin que sepamos
 * antes de quién es) y con ella sabemos qué saldo es.
 *
 * Retos: uno por petición (np:wpk:…:<reto>), de un solo uso y solo se gastan
 * con una firma buena; pedir retos o mandar basura no bloquea al dueño.
 */
@Injectable()
export class WalletPasskeysService {
  private readonly logger = new Logger(WalletPasskeysService.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(REDIS_CLIENT) redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;
  }

  async hasPasskey(walletId: string): Promise<boolean> {
    return (await this.prisma.walletPasskey.count({ where: { walletId } })) > 0;
  }

  /** Activar Face ID, paso 1 (desde el móvil del cliente). Una llave por saldo. */
  async registrationOptions(
    wallet: { id: string; shortCode: string | null },
    host: string | undefined,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (await this.hasPasskey(wallet.id)) throw new ConflictException({ message: 'Tu saldo ya tiene Face ID activado', code: 'FACE_ID_EXISTS' });
    const name = `Saldo ${BRAND_NAME}${wallet.shortCode ? ` · ${formatWalletCode(wallet.shortCode)}` : ''}`;
    const options = await generateRegistrationOptions({
      rpName: BRAND_NAME,
      rpID: currentRelyingParty(host).rpID,
      userName: name,
      userDisplayName: name,
      // El saldo: al pagar, el móvil devuelve esta llave y sabemos qué saldo es.
      userID: new TextEncoder().encode(wallet.id),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      preferredAuthenticatorType: 'localDevice',
    });
    await this.redis.set(regKey(wallet.id, options.challenge), '1', 'EX', CHALLENGE_TTL_S);
    return options;
  }

  /** Activar Face ID, paso 2: comprueba la respuesta del móvil y guarda la clave pública. */
  async register(walletId: string, host: string | undefined, response: unknown): Promise<void> {
    if (await this.hasPasskey(walletId)) throw new ConflictException({ message: 'Tu saldo ya tiene Face ID activado', code: 'FACE_ID_EXISTS' });
    const r = response as RegistrationResponseJSON | undefined;
    const challenge = challengeOf(r?.response?.clientDataJSON);
    const slot = challenge ? regKey(walletId, challenge) : null;
    if (!slot || (await this.redis.exists(slot)) === 0) {
      throw new ConflictException({ message: 'Ha tardado demasiado: vuelve a intentarlo', code: 'FACE_ID_TIMEOUT' });
    }
    const rp = currentRelyingParty(host);
    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const v = await verifyRegistrationResponse({
        response: r!,
        expectedChallenge: challenge!,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpIDs,
        requireUserVerification: true,
      });
      info = v.verified ? v.registrationInfo : undefined;
    } catch (err) {
      this.logger.warn(`passkey register rejected wallet=${walletId}: ${(err as Error).message}`);
    }
    if (!info) throw new ForbiddenException({ message: 'No se ha podido activar Face ID', code: 'FACE_ID_FAILED' });
    if ((await this.redis.del(slot)) !== 1) throw new ConflictException({ message: 'Esta activación ya se usó', code: 'FACE_ID_USED' });
    const c = info.credential;
    try {
      await this.prisma.acrossVenues(async (tx) => {
        // Una llave por saldo: con el saldo bloqueado, dos activaciones a la
        // vez no dejan dos llaves.
        await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE`;
        const existing = await tx.walletPasskey.findFirst({ where: { walletId }, select: { credentialId: true } });
        if (existing) {
          if (existing.credentialId === c.id) return;
          throw new ConflictException({ message: 'Tu saldo ya tiene Face ID activado', code: 'FACE_ID_EXISTS' });
        }
        await tx.walletPasskey.create({
          data: {
            walletId,
            credentialId: c.id,
            publicKey: Buffer.from(c.publicKey),
            counter: BigInt(c.counter),
            transports: c.transports ?? [],
          },
        });
      });
    } catch (err) {
      // La misma llave dos veces (doble toque): ya está.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }

  /**
   * Reto para pagar: sin decir qué llaves valen (el móvil del cliente elige
   * la suya). `scope` ata el reto a lo que se paga (un cobro, una fusión…).
   */
  async challenge(scope: string, host: string | undefined): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: currentRelyingParty(host).rpID,
      userVerification: 'required',
    });
    await this.redis.set(authKey(scope, options.challenge), '1', 'EX', CHALLENGE_TTL_S);
    return options;
  }

  /**
   * Saldo con Face ID: solo quien desbloquea su móvil (no basta el enlace)
   * puede hacer esto (`scope`: recargar, elegir PIN, «Me voy»…). Sin Face
   * ID, no pide nada. 403 si la llave es de otro saldo.
   */
  async assertOwner(walletId: string, scope: string, host: string | undefined, response: unknown): Promise<void> {
    if (!(await this.hasPasskey(walletId))) return;
    const owner = await this.verify(scope, host, response);
    if (owner !== walletId) throw new ForbiddenException({ message: 'Confirma con el Face ID de este saldo.', code: 'FACE_ID_WRONG' });
  }

  /**
   * Comprueba que el cliente desbloqueó su móvil con su llave para este
   * `scope`. Devuelve el saldo de esa llave.
   */
  async verify(scope: string, host: string | undefined, response: unknown): Promise<string> {
    const r = response as AuthenticationResponseJSON | undefined;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') {
      throw new ForbiddenException({ message: 'Confirma con Face ID, huella o el PIN de tu móvil', code: 'FACE_ID_REQUIRED' });
    }
    const key = await this.prisma.walletPasskey.findUnique({
      where: { credentialId: r.id },
      select: { walletId: true, credentialId: true, publicKey: true, counter: true, transports: true },
    });
    if (!key) {
      throw new ForbiddenException({ message: 'Esta llave no tiene saldo aquí: actívala en la página de tu recarga', code: 'FACE_ID_UNKNOWN' });
    }
    const challenge = challengeOf(r.response?.clientDataJSON);
    const slot = challenge ? authKey(scope, challenge) : null;
    if (!slot || (await this.redis.exists(slot)) === 0) {
      throw new ConflictException({ message: 'Ha tardado demasiado: vuelve a pulsar', code: 'FACE_ID_TIMEOUT' });
    }
    const rp = currentRelyingParty(host);
    let newCounter: number | null = null;
    try {
      const v = await verifyAuthenticationResponse({
        response: r,
        expectedChallenge: challenge!,
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
      this.logger.warn(`passkey assertion rejected wallet=${key.walletId}: ${(err as Error).message}`);
    }
    if (newCounter === null) throw new ForbiddenException({ message: 'No se ha podido comprobar tu Face ID', code: 'FACE_ID_FAILED' });
    // El reto se gasta solo con una firma buena; la misma firma dos veces, no.
    if ((await this.redis.del(slot)) !== 1) throw new ConflictException({ message: 'Esta confirmación ya se usó', code: 'FACE_ID_USED' });
    await this.prisma.walletPasskey.update({
      where: { credentialId: key.credentialId },
      data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
    });
    return key.walletId;
  }
}

const regKey = (walletId: string, challenge: string): string => `np:wpk:reg:${walletId}:${challenge}`;
const authKey = (scope: string, challenge: string): string => `np:wpk:auth:${scope}:${challenge}`;

/** El reto que firmó el móvil (va dentro de clientDataJSON). */
function challengeOf(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof data.challenge === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(data.challenge) ? data.challenge : null;
  } catch {
    return null;
  }
}
