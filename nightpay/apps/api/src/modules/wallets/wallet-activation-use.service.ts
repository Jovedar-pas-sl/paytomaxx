import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { isGiftPaymentKey } from '../home-topup/home-topup-rules';
import { AuditService } from '../audit/audit.service';
import { WALLET_CLAIM_MAX_AGE_S } from '../payments/wallet-claim';
import { codeHintOf, WalletChargesService } from './wallet-charges.service';
import { WalletLiveCodeService } from './wallet-live-code.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { FRESH_TOPUP_MS, firstTopUp } from './wallet-fresh-topup';
import { newWalletToken } from './wallet-rules';
import {
  activationError,
  activationStateOf,
  activationTokenHash,
  isActivationToken,
  spendActivationToken,
  type ActivationUse,
  type ActivationVia,
} from './wallet-activation-token';

/** Lo que enseña /w/a/<token> (nunca el enlace del saldo ni lo que tiene). */
export type ActivationView =
  | { state: 'ok'; codeHint: string | null; venueName: string | null; hasPin: boolean; pinRequired: boolean }
  | { state: 'used' }
  | { state: 'expired' };

/** El saldo de un QR de activación vigente (antes de registrar nada). */
interface UsableWallet {
  id: string;
  shortCode: string | null;
  tenantId: string;
  qrToken: string;
  hasPin: boolean;
  via: ActivationVia;
  balanceCents: number;
  issuedAt: Date;
}

/**
 * El QR de recepción de un saldo con PIN pide ese PIN: recepción no prueba que
 * el saldo sea de quien está delante. El enlace nuevo del dueño (con 2FA) es
 * para quien lo perdió todo, y puede haber olvidado también el PIN.
 */
function needsPin(wallet: UsableWallet): boolean {
  return wallet.hasPin && wallet.via === 'reception';
}

/** «Tu saldo ya tiene Face ID activado» de WalletPasskeysService.register. */
function isFaceIdExists(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 'FACE_ID_EXISTS';
}

const ACTIVE_STATUSES = new Set(['ACTIVE', 'DEPLETED']);
const PAID_STATUSES = ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

/**
 * El cliente usa el QR de activación (/w/a/<token>, M-2) en SU móvil:
 *  - view(): lo que enseña la página. No escribe nada (WhatsApp abre los
 *    enlaces para la vista previa).
 *  - registerPasskey() / setPin(): el primer Face ID o el primer PIN del
 *    saldo, gastando el QR en la MISMA transacción (con dos a la vez, gana
 *    uno; si falla el registro, el QR sigue valiendo). Devuelve el enlace del
 *    saldo para que SU móvil vaya a él (con su sesión, si es Face ID): el
 *    enlace no sale nunca en la pantalla del personal.
 * Solo para saldos sin Face ID: con él, el QR ya no tiene nada que activar.
 *
 * payerBase(): para la página del saldo, la vía de siempre del móvil que pagó
 * la recarga que creó el saldo (/pay/<token>: su cookie del pago).
 */
@Injectable()
export class WalletActivationUseService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(AuditService) private readonly audit: AuditService,
    // Sin @Optional(): sin él la API no arranca. Opcional solo para los `new` de las pruebas.
    @Inject(WalletLiveCodeService) private readonly liveCodes?: WalletLiveCodeService,
  ) {}

  async view(token: string, now: Date = new Date()): Promise<ActivationView> {
    const found = await this.read(token, now);
    if (found.state !== 'ok') return { state: found.state };
    const venue = await this.prisma.acrossVenues((tx) =>
      tx.venue.findUnique({ where: { id: found.wallet.tenantId }, select: { name: true } }),
    );
    return {
      state: 'ok',
      codeHint: found.wallet.shortCode ? codeHintOf(found.wallet.shortCode) : null,
      venueName: venue?.name ?? null,
      hasPin: found.wallet.hasPin,
      pinRequired: needsPin(found.wallet),
    };
  }

  /** Activar Face ID, paso 1 (solo con el QR vigente, y con su PIN si lo pide: antes de crear la llave en el móvil). */
  async passkeyOptions(token: string, host: string | undefined, pin?: unknown): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const wallet = await this.usable(token);
    await this.assertPin(wallet, pin);
    return this.passkeys.registrationOptions({ id: wallet.id, shortCode: wallet.shortCode }, host);
  }

  /** Activar Face ID, paso 2: la llave del móvil, gastando el QR en la misma transacción. */
  async registerPasskey(
    token: string,
    host: string | undefined,
    response: unknown,
    pin?: unknown,
  ): Promise<{ walletId: string; qrToken: string; hadPin: boolean }> {
    const wallet = await this.usable(token);
    await this.assertPin(wallet, pin);
    try {
      await this.passkeys.register(wallet.id, host, response, {
        beforeInsert: (tx) => this.spend(tx, token, wallet.id, 'passkey'),
      });
    } catch (err) {
      // Otro móvil activó Face ID con este mismo QR un instante antes: para este
      // QR es lo mismo que gastado (un saldo con Face ID no tiene nada que activar).
      if (isFaceIdExists(err)) throw activationError('used');
      throw err;
    }
    // El saldo ya tenía PIN (el cliente, la chica o el encargado): se le avisa por si no fue él.
    await this.logUse(wallet, 'passkey');
    return { walletId: wallet.id, qrToken: wallet.qrToken, hadPin: wallet.hasPin };
  }

  /**
   * El primer PIN (móvil sin Face ID, o si lo prefiere), gastando el QR en la
   * misma transacción. El enlace cambia: con PIN no hay llave que bloquee la
   * página, y un enlace visto antes seguiría abriéndola. Con Face ID no hace
   * falta: la página ya pide la llave.
   */
  async setPin(token: string, pin: string): Promise<{ walletId: string; qrToken: string }> {
    const wallet = await this.usable(token);
    const qrToken = newWalletToken();
    await this.charges.setFirstPinWithActivation(wallet.id, pin, async (tx) => {
      await this.spend(tx, token, wallet.id, 'pin');
      // Con Face ID (activado por otra vía mientras tanto), el PIN se elige con su llave en /w.
      if ((await tx.walletPasskey.count({ where: { walletId: wallet.id } })) > 0) throw activationError('used');
      await tx.clientWallet.update({ where: { id: wallet.id }, data: { qrToken } });
    });
    // Guardado el enlace nuevo: los códigos del móvil del de antes, anulados (si falla, viven sus 60 s).
    await this.liveCodes?.dropWallet(wallet.id).catch(() => undefined);
    await this.logUse(wallet, 'pin');
    return { walletId: wallet.id, qrToken };
  }

  private async assertPin(wallet: UsableWallet, pin: unknown): Promise<void> {
    if (!needsPin(wallet)) return;
    if (typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) throw new BadRequestException({ message: 'El PIN son 4 cifras', code: 'PIN_FORMAT' });
    await this.charges.checkClientPin(wallet.id, wallet.tenantId, pin);
  }

  /**
   * La vía de siempre para el primer Face ID o PIN desde la página del saldo:
   * el navegador que pagó la recarga con tarjeta que creó el saldo (su cookie
   * del pago va a /pay/<token>, PublicPayController.payerWallet). null si la
   * primera recarga no fue un pago con tarjeta cobrado, o si se cobró hace más
   * de lo que dura esa cookie (7 días): entonces ya no sirve y el enlace del
   * pago no tiene por qué salir en la página.
   */
  async payerBase(walletId: string, now: Date = new Date()): Promise<string | null> {
    const first = await firstTopUp(this.prisma, walletId);
    if (!first?.paymentId) return null;
    const paymentId = first.paymentId;
    const since = new Date(now.getTime() - WALLET_CLAIM_MAX_AGE_S * 1000);
    const payment = await this.prisma.acrossVenues((tx) =>
      tx.payment.findFirst({
        where: { id: paymentId, walletId, status: { in: [...PAID_STATUSES] }, authorizedAt: { gte: since } },
        select: { qrToken: true, idempotencyKey: true },
      }),
    );
    // Un regalo: quien lo pagó no tiene esa vía (el saldo es de quien lo guardó).
    if (isGiftPaymentKey(payment?.idempotencyKey)) return null;
    return payment?.qrToken ? `/pay/${encodeURIComponent(payment.qrToken)}` : null;
  }

  /** El QR y su saldo, sin tocar nada. Un saldo cerrado, bloqueado o sumado a otro no se activa. */
  private async read(
    token: string,
    now: Date,
  ): Promise<{ state: 'ok'; wallet: UsableWallet } | { state: 'used' | 'expired' }> {
    if (!isActivationToken(token)) return { state: 'expired' };
    const row = await this.prisma.acrossVenues((tx) =>
      tx.walletActivationToken.findUnique({
        where: { tokenHash: activationTokenHash(token) },
        select: {
          usedAt: true,
          revokedAt: true,
          expiresAt: true,
          createdAt: true,
          via: true,
          wallet: {
            select: {
              id: true,
              shortCode: true,
              tenantId: true,
              qrToken: true,
              balanceCents: true,
              status: true,
              blockedAt: true,
              mergedIntoId: true,
              pinHash: true,
              _count: { select: { passkeys: true } },
              gift: { select: { claimedAt: true } },
            },
          },
        },
      }),
    );
    const state = activationStateOf(row, now);
    if (!row || state === null || state === 'expired') return { state: 'expired' };
    if (state === 'used') return { state: 'used' };
    const w = row.wallet;
    // Ya con Face ID (por otra vía): el QR no tiene nada que activar.
    if (w._count.passkeys > 0) return { state: 'used' };
    // Un regalo ya guardado (con otro QR del mismo enlace): este ya no activa nada.
    if (row.via === 'gift' && (w.gift?.claimedAt || w.pinHash !== null)) return { state: 'used' };
    if (!ACTIVE_STATUSES.has(w.status) || w.blockedAt || w.mergedIntoId) return { state: 'expired' };
    return {
      state: 'ok',
      wallet: {
        id: w.id,
        shortCode: w.shortCode,
        tenantId: w.tenantId,
        qrToken: w.qrToken,
        hasPin: w.pinHash !== null,
        via: row.via === 'relink' || row.via === 'gift' ? row.via : 'reception',
        balanceCents: w.balanceCents,
        issuedAt: row.createdAt,
      },
    };
  }

  /** El saldo del QR si se puede usar; si no, 409 (usado) o 410 (caducado, anulado o desconocido). */
  private async usable(token: string): Promise<UsableWallet> {
    const found = await this.read(token, new Date());
    if (found.state !== 'ok') throw activationError(found.state);
    return found.wallet;
  }

  private async spend(tx: TransactionalClient, token: string, walletId: string, use: ActivationUse): Promise<void> {
    const spent = await spendActivationToken(tx, token, use);
    if (spent.walletId !== walletId) throw activationError('expired');
    // Un regalo («Regala una noche») queda guardado en la misma transacción: su enlace ya no da nada.
    await tx.walletGift.updateMany({ where: { walletId, claimedAt: null }, data: { claimedAt: new Date() } });
  }

  private async logUse(wallet: UsableWallet, usedFor: ActivationUse): Promise<void> {
    await this.audit.log({
      action: 'wallet.activation_used',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { usedFor, via: wallet.via, ...(usedFor === 'passkey' ? { hadPin: wallet.hasPin } : {}) },
    });
    await this.flagIfNotNew(wallet);
  }

  /** Un saldo que ya tenía dinero ha pasado a un móvil por el QR de recepción: lo ve el encargado en Incidencias. */
  private async flagIfNotNew(wallet: UsableWallet): Promise<void> {
    if (wallet.via !== 'reception' || wallet.balanceCents <= 0) return;
    const first = await firstTopUp(this.prisma, wallet.id);
    if (first?.at && first.at.getTime() >= wallet.issuedAt.getTime() - FRESH_TOPUP_MS) return;
    await this.audit.log({
      action: 'wallet.activation_not_new',
      tenantId: wallet.tenantId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { amountCents: wallet.balanceCents, hadPin: wallet.hasPin },
    });
  }
}
