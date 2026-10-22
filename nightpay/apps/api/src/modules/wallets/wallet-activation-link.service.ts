import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ACTIVATION_LINK_REASON_TEXT,
  ACTIVATION_LINK_UNAVAILABLE_CODE,
  ACTIVATION_LINK_WINDOW_MINUTES,
  type ActivationLinkUnavailableReason,
  type WalletActivationLink,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { PRINTED_INTENT_PREFIX } from './wallet-cash-intent';
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
 * no prueba que el cliente esté delante (abrirían su enlace privado).
 */
export async function lastTopUpHere(tx: TopUpTx, venueId: string, walletIds: string[], since: Date): Promise<Date | null> {
  const [cash, card] = await Promise.all([
    tx.walletCashTopUp.findFirst({
      where: {
        tenantId: venueId, walletId: { in: walletIds }, amountCents: { gt: 0 }, voidedBy: { is: null }, createdAt: { gte: since },
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
 * el enlace privado del saldo, para que el cliente que recargó en efectivo
 * active Face ID en su móvil. Solo recepción, encargado y dueño; solo en los
 * 15 min tras una recarga de este local; solo si aún no tiene Face ID.
 * El enlace no se registra: el registro lleva el saldo, quién y hasta cuándo.
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

  async link(actor: ActivationLinkActor, walletId: string, now: Date = new Date()): Promise<WalletActivationLink> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, actor));
    const since = new Date(now.getTime() - WINDOW_MS);
    const found = await this.prisma.acrossVenues(async (tx) => {
      const wallet = await tx.clientWallet.findUnique({
        where: { id: walletId },
        select: { id: true, tenantId: true, walletGroup: true, qrToken: true, status: true, blockedAt: true, mergedIntoId: true, pendingAssignAt: true },
      });
      // Bloqueado, cerrado, sumado a otro o recarga aún sin su cliente: no es el saldo de nadie que esté delante.
      if (!wallet || wallet.status !== 'ACTIVE' || wallet.blockedAt || wallet.mergedIntoId || wallet.pendingAssignAt) return null;
      const venue = await tx.venue.findUnique({ where: { id: actor.tenantId }, select: { walletGroup: true } });
      if (!sameWalletGroup(wallet, { id: actor.tenantId, walletGroup: venue?.walletGroup ?? null })) return null;
      const merged = await tx.clientWallet.findMany({ where: { mergedIntoId: wallet.id }, select: { id: true } });
      const at = await lastTopUpHere(tx, actor.tenantId, [wallet.id, ...merged.map((m) => m.id)], since);
      return { qrToken: wallet.qrToken, at };
    });
    if (!found) throw activationLinkUnavailable('NOT_FOUND');
    if (await this.passkeys.hasPasskey(walletId)) throw activationLinkUnavailable('FACE_ID_SET');
    if (!found.at) throw activationLinkUnavailable('NO_RECENT_TOP_UP');
    const expiresAt = new Date(found.at.getTime() + WINDOW_MS);
    await this.audit.log({
      action: 'wallet.activation_link',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: walletId,
      payload: { topUpAt: found.at.toISOString(), expiresAt: expiresAt.toISOString() },
    });
    return { url: `${this.origin}/w/${encodeURIComponent(found.qrToken)}`, expiresAt: expiresAt.toISOString() };
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
