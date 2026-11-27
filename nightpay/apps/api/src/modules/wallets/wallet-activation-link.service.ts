import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ACTIVATION_LINK_REASON_TEXT,
  ACTIVATION_LINK_UNAVAILABLE_CODE,
  ACTIVATION_LINK_WINDOW_MINUTES,
  normalizeWalletCardUid,
  type ActivationLinkUnavailableReason,
  type WalletActivationLink,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { PRINTED_INTENT_PREFIX } from './wallet-cash-intent';
import { activationPath, issueActivationToken } from './wallet-activation-token';
import { isIssuedCard } from './wallet-card-ops';
import { firstTopUp } from './wallet-fresh-topup';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { sameWalletGroup } from './wallet-rules';

/** Sin NEXT_PUBLIC_API_URL (solo en local): el API en su puerto. */
const LOCAL_API_ORIGIN = 'http://localhost:4100';
const WINDOW_MS = ACTIVATION_LINK_WINDOW_MINUTES * 60 * 1000;

export interface ActivationLinkActor {
  userId: string;
  role: string;
  tenantId: string;
}

type TopUpTx = Pick<TransactionalClient, 'walletCashTopUp' | 'payment'>;

export function activationLinkUnavailable(reason: ActivationLinkUnavailableReason): NotFoundException {
  return new NotFoundException({ message: ACTIVATION_LINK_REASON_TEXT[reason], code: ACTIVATION_LINK_UNAVAILABLE_CODE, reason });
}

/**
 * La última recarga hecha EN ESTE LOCAL a estos saldos (el del cliente y los
 * sumados a él: una recarga pendiente de asignar llega por fusión) desde
 * `since`: en efectivo (sin anular) o con tarjeta (aprobada). null si no hay.
 * Las recargas por número impreso no cuentan: el número se lee en la ficha y
 * no prueba que el cliente esté delante (abrirían su enlace privado); las de
 * los cajeros de otras plataformas (API de socios), tampoco.
 */
export async function lastTopUpHere(tx: TopUpTx, venueId: string, walletIds: string[], since: Date): Promise<Date | null> {
  const [cash, card] = await Promise.all([
    tx.walletCashTopUp.findFirst({
      where: {
        tenantId: venueId, walletId: { in: walletIds }, amountCents: { gt: 0 }, voidedBy: { is: null }, createdAt: { gte: since },
        // La de un cajero de otra plataforma no prueba que el cliente esté en recepción.
        partnerConnectionId: null,
        OR: [{ intentFingerprint: null }, { NOT: { intentFingerprint: { startsWith: PRINTED_INTENT_PREFIX } } }],
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    tx.payment.findFirst({
      where: { tenantId: venueId, walletId: { in: walletIds }, status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED'] }, authorizedAt: { gte: since } },
      orderBy: { authorizedAt: 'desc' },
      select: { authorizedAt: true },
    }),
  ]);
  const times = [cash?.createdAt, card?.authorizedAt].filter((d): d is Date => d instanceof Date);
  return times.length === 0 ? null : new Date(Math.max(...times.map((d) => d.getTime())));
}

/**
 * QR de activación (contrato en @nightpay/contracts, wallet-activation.ts):
 * un enlace de activación de UN SOLO USO (/w/a/<token>, 10 min) para que el
 * cliente que recargó en efectivo active Face ID (o elija su PIN) en su móvil.
 * Nunca el enlace permanente del saldo (M-2: quien fotografiara el QR podía
 * quedarse con el saldo). Pedir otro anula los anteriores sin usar. Solo
 * recepción, encargado y dueño; solo en los 15 min tras una recarga de este
 * local; solo si aún no tiene Face ID. Ni el token ni el enlace se registran:
 * el registro lleva el saldo, quién, cómo y hasta cuándo.
 *
 * Una recarga no prueba que el saldo sea de quien está delante: con su código
 * y un céntimo, recepción (o quien robe su sesión) se abriría un saldo ajeno.
 * Por eso un saldo que no es nuevo pide algo más: su PIN (lo teclea el cliente
 * en /w/a/) o, si no tiene, la ficha que se acaba de leer.
 */
@Injectable()
export class WalletActivationLinkService {
  private readonly origin: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.origin = originOf(config.get<string>('NEXT_PUBLIC_API_URL')) ?? LOCAL_API_ORIGIN;
  }

  async link(
    actor: ActivationLinkActor,
    walletId: string,
    now: Date = new Date(),
    proof: { card?: string; uid?: string } = {},
  ): Promise<WalletActivationLink> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, actor));
    const since = new Date(now.getTime() - WINDOW_MS);
    const found = await this.prisma.acrossVenues(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({
        where: { id: walletId },
        select: { id: true, tenantId: true, walletGroup: true, status: true, blockedAt: true, mergedIntoId: true, pendingAssignAt: true, pinHash: true },
      });
      // Bloqueado, cerrado, sumado a otro o recarga aún sin su cliente: no es el saldo de nadie que esté delante.
      if (!wallet || wallet.status !== 'ACTIVE' || wallet.blockedAt || wallet.mergedIntoId || wallet.pendingAssignAt) return null;
      const venue = await tx.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
      if (!sameWalletGroup(wallet, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null })) return null;
      const merged = await tx.clientWallet.findMany({ where: { mergedIntoId: wallet.id }, select: { id: true } });
      const at = await lastTopUpHere(tx, actor.tenantId, [wallet.id, ...merged.map((m) => m.id)], since);
      return { at, hasPin: wallet.pinHash !== null };
    });
    if (!found) throw activationLinkUnavailable('NOT_FOUND');
    if (await this.passkeys.hasPasskey(walletId)) throw activationLinkUnavailable('FACE_ID_SET');
    if (!found.at) throw activationLinkUnavailable('NO_RECENT_TOP_UP');
    if (!found.hasPin && !(await this.isNew(walletId, since)) && !(await this.cardProves(walletId, proof))) {
      throw activationLinkUnavailable('NEEDS_PROOF');
    }
    const issued = await this.prisma.acrossVenues((tx) =>
      issueActivationToken(tx, { walletId, venueId: actor.tenantId, issuedById: actor.userId, via: 'reception', now }),
    );
    const expiresAt = issued.expiresAt.toISOString();
    await this.audit.log({
      action: 'wallet.activation_link',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { via: 'reception', topUpAt: found.at.toISOString(), expiresAt },
    });
    return { url: `${this.origin}${activationPath(issued.token)}`, expiresAt };
  }

  /** El saldo nació con esta recarga: nadie tenía nada en él. */
  private async isNew(walletId: string, since: Date): Promise<boolean> {
    const first = await firstTopUp(this.prisma, walletId);
    return first?.at ? first.at >= since : false;
  }

  /** La ficha leída es la de este saldo. El número de serie, si lo hay por los dos lados, tiene que coincidir. */
  private async cardProves(walletId: string, proof: { card?: string; uid?: string }): Promise<boolean> {
    const token = proof.card;
    if (!token) return false;
    const card = await this.prisma.acrossVenues((tx) => tx.walletCard.findUnique({ where: { token } }));
    if (!card || card.walletId !== walletId || !isIssuedCard(card)) return false;
    const uid = proof.uid ? normalizeWalletCardUid(proof.uid) : null;
    return !(card.uid && uid && card.uid !== uid);
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
