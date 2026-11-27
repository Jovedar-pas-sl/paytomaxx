import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CHARGE_METHOD_LABELS, formatChargeRef, type WalletFicha, type WalletFichaTopUp } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ISSUED_CARD_STATUSES } from '../wallets/wallet-card-ops';
import { formatWalletCode, sameWalletGroup } from '../wallets/wallet-rules';
import { paymentMethodLabel, paymentMethodOf, personOf } from './cobros-rows';
import { peopleById, saldoCharges } from './cobros.service';
import { partnerLabel } from '../reports/export-csv';

const PAID = ['AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const MAX_ROWS = 200;

/**
 * Ficha del saldo (panel, el mapa del dinero): sus recargas (cómo y quién),
 * lo que gastó (referencia, chica, sección y servicio) y lo que se le
 * devolvió. El saldo vale en todo el grupo: se lee de todos sus locales
 * (acrossVenues), solo si es del grupo del local de quien mira.
 */
@Injectable()
export class WalletFichaService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  async ficha(tenantId: string, walletId: string): Promise<WalletFicha> {
    return this.prisma.acrossVenues(async (tx) => {
      const [venue, wallet] = await Promise.all([
        tx.venue.findUnique({ where: { id: tenantId }, select: { id: true, walletGroup: true } }),
        tx.clientWallet.findUnique({
          where: { id: walletId },
          select: {
            id: true,
            tenantId: true,
            walletGroup: true,
            shortCode: true,
            identifier: true,
            contactPhone: true,
            balanceCents: true,
            status: true,
            createdAt: true,
            pinHash: true,
            _count: { select: { passkeys: true, cards: { where: { status: { in: ISSUED_CARD_STATUSES } } } } },
          },
        }),
      ]);
      if (!venue || !wallet || !sameWalletGroup(wallet, venue)) throw new NotFoundException('Saldo no encontrado');

      const [payments, cash, consumptions, payouts, cards] = await Promise.all([
        tx.payment.findMany({
          where: { walletId, status: { in: [...PAID] } },
          orderBy: { createdAt: 'desc' },
          take: MAX_ROWS,
          select: {
            id: true,
            tenantId: true,
            ref: true,
            createdAt: true,
            authorizedAt: true,
            amountCents: true,
            serviceFeeCents: true,
            status: true,
            captureMethod: true,
            posOperationNumber: true,
            cardBrand: true,
            cardLast4: true,
            attempts: { select: { status: true, payMethod: true }, orderBy: { createdAt: 'asc' } },
            createdBy: { select: { id: true, displayName: true, email: true, role: true } },
            terminal: { select: { label: true } },
          },
        }),
        tx.walletCashTopUp.findMany({
          where: { walletId },
          orderBy: { createdAt: 'desc' },
          take: MAX_ROWS,
          select: {
            id: true,
            tenantId: true,
            amountCents: true,
            serviceFeeCents: true,
            createdAt: true,
            takenByUserId: true,
            terminalId: true,
            reason: true,
            partnerConnectionId: true,
          },
        }),
        saldoCharges(tx, { walletId }, MAX_ROWS),
        tx.walletPayout.findMany({
          where: { walletId, status: { in: ['DONE', 'PENDING'] } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, tenantId: true, amountCents: true, method: true, status: true, createdAt: true, paidByUserId: true, bankReference: true },
        }),
        tx.walletCard.findMany({
          where: { walletId, status: { in: [...ISSUED_CARD_STATUSES, 'BLOCKED'] } },
          orderBy: [{ linkedAt: 'desc' }, { createdAt: 'desc' }],
          select: { id: true, uid: true, token: true, status: true, linkedAt: true },
        }),
      ]);
      const venueIds = [
        ...new Set([wallet.tenantId, ...[...payments, ...cash, ...consumptions, ...payouts].map((r) => r.tenantId)]),
      ];
      const terminalIds = cash.flatMap((c) => (c.terminalId ? [c.terminalId] : []));
      const connectionIds = [...new Set(cash.flatMap((c) => (c.partnerConnectionId ? [c.partnerConnectionId] : [])))];
      const [venues, terminals, people, connections] = await Promise.all([
        tx.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } }),
        terminalIds.length > 0
          ? tx.terminal.findMany({ where: { id: { in: terminalIds } }, select: { id: true, label: true } })
          : Promise.resolve([]),
        peopleById(tx, [...cash.flatMap((c) => (c.takenByUserId ? [c.takenByUserId] : [])), ...payouts.map((p) => p.paidByUserId)]),
        // El socio de las recargas que cobró un cajero de otra plataforma (API de socios).
        connectionIds.length > 0
          ? tx.partnerConnection.findMany({ where: { id: { in: connectionIds } }, select: { id: true, partner: { select: { name: true } } } })
          : Promise.resolve([]),
      ]);
      const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? '';

      const cardTopUps: WalletFichaTopUp[] = payments.map((p) => {
        const method = paymentMethodOf(p) ?? 'CARD';
        return {
          kind: 'PAYMENT',
          id: p.id,
          ref: formatChargeRef(p.ref),
          at: (p.authorizedAt ?? p.createdAt).toISOString(),
          amountCents: p.amountCents,
          serviceFeeCents: p.serviceFeeCents ?? 0,
          method,
          methodLabel: paymentMethodLabel(method, p),
          by: personOf(p.createdBy),
          terminalLabel: method === 'POS' ? p.terminal.label : null,
          venueName: venueName(p.tenantId),
          status: p.status,
          note: null,
        };
      });
      const cashTopUps: WalletFichaTopUp[] = cash.map((c) => ({
        kind: 'CASH',
        id: c.id,
        ref: null,
        at: c.createdAt.toISOString(),
        amountCents: c.amountCents,
        serviceFeeCents: c.serviceFeeCents ?? 0,
        method: 'CASH',
        methodLabel: c.amountCents < 0 ? `${CHARGE_METHOD_LABELS.CASH} (anulada)` : CHARGE_METHOD_LABELS.CASH,
        // El efectivo de un cajero lo cobró el socio (también si la anulación se hizo en el panel).
        by: c.partnerConnectionId
          ? {
              id: c.partnerConnectionId,
              name: partnerLabel(connections.find((pc) => pc.id === c.partnerConnectionId)?.partner.name),
              role: 'PARTNER',
            }
          : personOf(c.takenByUserId ? people.get(c.takenByUserId) : null),
        terminalLabel: c.terminalId ? (terminals.find((t) => t.id === c.terminalId)?.label ?? null) : null,
        venueName: venueName(c.tenantId),
        status: c.amountCents < 0 ? 'VOID' : 'DONE',
        note: c.reason,
      }));

      return {
        wallet: {
          id: wallet.id,
          code: wallet.shortCode ? formatWalletCode(wallet.shortCode) : null,
          label: wallet.identifier,
          contactPhone: wallet.contactPhone,
          balanceCents: wallet.balanceCents,
          status: wallet.status,
          createdAt: wallet.createdAt.toISOString(),
          homeVenueName: venueName(wallet.tenantId),
          hasPin: wallet.pinHash !== null,
          hasCard: wallet._count.cards > 0,
          hasFaceId: wallet._count.passkeys > 0,
        },
        topUps: [...cardTopUps, ...cashTopUps].sort((a, b) => b.at.localeCompare(a.at)),
        consumptions: consumptions.map(({ tenantId: t, ...row }) => ({ ...row, venueName: venueName(t) })),
        refunds: payouts.map((p) => ({
          id: p.id,
          at: p.createdAt.toISOString(),
          amountCents: p.amountCents,
          method: p.method === 'CASH' ? 'CASH' : 'CARD',
          status: p.status,
          by: personOf(people.get(p.paidByUserId)),
          bankReference: p.bankReference,
          venueName: venueName(p.tenantId),
        })),
        cards: cards.map((c) => ({ id: c.id, label: cardLabel(c), status: c.status, linkedAt: c.linkedAt?.toISOString() ?? null })),
      };
    });
  }
}

/** Para reconocer una ficha: «nº 0417» (final del número de serie) o el principio de su código grabado. */
export function cardLabel(c: { uid: string | null; token: string }): string {
  const uid = c.uid?.replace(/[^0-9a-fA-F]/g, '') ?? '';
  return uid ? `nº ${uid.slice(-4).toUpperCase()}` : `${c.token.slice(0, 6)}…`;
}
