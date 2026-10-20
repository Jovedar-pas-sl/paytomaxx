import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CHARGE_METHOD_LABELS, formatChargeRef, type WalletFicha, type WalletFichaTopUp } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ISSUED_CARD_STATUSES } from '../wallets/wallet-card-ops';
import { formatWalletCode, sameWalletGroup } from '../wallets/wallet-rules';
import { paymentMethodLabel, paymentMethodOf, personOf } from './cobros-rows';
import { peopleById, saldoCharges } from './cobros.service';

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
            balanceCents: true,
            status: true,
            createdAt: true,
            pinHash: true,
            _count: { select: { passkeys: true, cards: { where: { status: { in: ISSUED_CARD_STATUSES } } } } },
          },
        }),
      ]);
      if (!venue || !wallet || !sameWalletGroup(wallet, venue)) throw new NotFoundException('Saldo no encontrado');

      const [payments, cash, consumptions, payouts] = await Promise.all([
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
          select: { id: true, tenantId: true, amountCents: true, createdAt: true, takenByUserId: true, terminalId: true, reason: true },
        }),
        saldoCharges(tx, { walletId }, MAX_ROWS),
        tx.walletPayout.findMany({
          where: { walletId, status: { in: ['DONE', 'PENDING'] } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, tenantId: true, amountCents: true, method: true, status: true, createdAt: true, paidByUserId: true, bankReference: true },
        }),
      ]);
      const venueIds = [
        ...new Set([wallet.tenantId, ...[...payments, ...cash, ...consumptions, ...payouts].map((r) => r.tenantId)]),
      ];
      const terminalIds = cash.flatMap((c) => (c.terminalId ? [c.terminalId] : []));
      const [venues, terminals, people] = await Promise.all([
        tx.venue.findMany({ where: { id: { in: venueIds } }, select: { id: true, name: true } }),
        terminalIds.length > 0
          ? tx.terminal.findMany({ where: { id: { in: terminalIds } }, select: { id: true, label: true } })
          : Promise.resolve([]),
        peopleById(tx, [...cash.flatMap((c) => (c.takenByUserId ? [c.takenByUserId] : [])), ...payouts.map((p) => p.paidByUserId)]),
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
        method: 'CASH',
        methodLabel: c.amountCents < 0 ? `${CHARGE_METHOD_LABELS.CASH} (anulada)` : CHARGE_METHOD_LABELS.CASH,
        by: personOf(c.takenByUserId ? people.get(c.takenByUserId) : null),
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
      };
    });
  }
}
