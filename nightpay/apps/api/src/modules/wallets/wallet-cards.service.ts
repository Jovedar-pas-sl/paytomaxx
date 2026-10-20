import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  cardPanelActionProblem,
  isWalletCardStatus,
  isWalletCardToken,
  normalizeWalletCardUid,
  type FichasNight,
  type FichasSummary,
  type ReceptionDeskView,
  type Role,
  type StockOutcome,
  type WalletCardPanelAction,
  type WalletCardRow,
  type WalletCardStatus,
} from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { fichasCounts, frozenFichas } from './fichas-counts';
import { readReceptionDesk, type DeskRef } from './reception-desk';
import {
  ISSUED_CARD_STATUSES,
  createCardToken,
  isIssuedCard,
  lockCard,
  recordCardEvents,
  type CardBy,
} from './wallet-card-ops';
import { formatWalletCode, normalizeWalletCode, sameWalletGroup } from './wallet-rules';

type Actor = { userId: string; role: Role; tenantId: string };

/** Cuántas fichas como mucho en la lista del panel (se busca por número de serie o código). */
const LIST_LIMIT = 100;
/** Noches del resumen de fichas. */
const SUMMARY_NIGHTS = 14;

/**
 * Stock de fichas NFC de un local (Clientes → Fichas, «Preparar fichas»).
 * STOCK (grabada, sin dar) → ISSUED (dada a un saldo) → RETURNED (devuelta,
 * otra vez en el stock) | LOST | BLOCKED. Las fichas no tienen RLS: el local
 * va siempre explícito (venueId) y las lecturas con acrossVenues.
 */
@Injectable()
export class WalletCardsService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;

  constructor(@Inject(PrismaService) prisma: PrismaService, @Inject(AuditService) audit: AuditService) {
    this.prisma = prisma;
    this.audit = audit;
  }

  // ─── «Preparar fichas» (personal o datáfono) ───────────────────────────

  /** Código nuevo (del servidor) para grabar en la próxima ficha vacía. */
  async newStockToken(venueId: string, by: CardBy): Promise<{ card: string }> {
    await this.assertNfc(venueId);
    return { card: await createCardToken(this.prisma, venueId, by) };
  }

  /**
   * La ficha que acaban de acercar, al stock de este local:
   *  - recién grabada → stocked;
   *  - ya en el stock (aquí u otro local del grupo) → already (queda en este);
   *  - dada a un saldo gastado o cerrado → returned (vuelve al stock);
   *  - sustituida por otra (perdida sin saldo) → returned: ha aparecido;
   *  - dada a un saldo con dinero → in-use (se aparta: es del cliente);
   *  - marcada perdida desde el panel, bloqueada, copiada o de otro grupo → se aparta.
   */
  async stock(venueId: string, by: CardBy, input: { card: string; uid?: string | null }): Promise<StockOutcome> {
    await this.assertNfc(venueId);
    if (!isWalletCardToken(input.card)) return { outcome: 'foreign' };
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    const group = { id: venueId, walletGroup: venue?.walletGroup ?? null };
    const outcome = await this.prisma.acrossVenues(async (tx) => {
      const card = await lockCard(tx, input.card);
      if (!card || (card.uid && uid && card.uid !== uid)) return { outcome: 'foreign' } as const;
      if (card.venueId && card.venueId !== venueId) {
        const home = await tx.venue.findUnique({ where: { id: card.venueId }, select: { walletGroup: true } });
        if (!sameWalletGroup({ tenantId: card.venueId, walletGroup: home?.walletGroup ?? null }, group)) {
          return { outcome: 'foreign' } as const;
        }
      }
      const now = new Date();
      // Sustituida al dar otra al mismo saldo (perdida, sin saldo, y su último
      // «perdida» dice de qué saldo era): ha aparecido, vuelve al stock. Una
      // marcada perdida desde el panel, no (la recupera el encargado).
      if (card.status === 'LOST' && !card.walletId && (await wasReplaced(tx, card.id))) {
        await tx.walletCard.update({
          where: { id: card.id },
          data: { status: 'RETURNED', returnedAt: now, venueId, uid: card.uid ?? uid },
        });
        await recordCardEvents(tx, [{ cardId: card.id, walletId: null, kind: 'RETURNED' }], { venueId, by, now });
        return { outcome: 'returned', codeHint: '•••-•••' } as const;
      }
      if (card.status === 'LOST') return { outcome: 'lost' } as const;
      if (card.status === 'BLOCKED') return { outcome: 'blocked' } as const;
      const walletId = isIssuedCard(card) ? card.walletId : null;
      if (walletId) {
        const wallet = await tx.clientWallet.findUnique({
          where: { id: walletId },
          select: { status: true, balanceCents: true, shortCode: true },
        });
        const codeHint = `${(wallet?.shortCode ?? '').slice(0, 3)}-•••`;
        if (wallet?.status === 'ACTIVE' && wallet.balanceCents > 0) return { outcome: 'in-use', codeHint } as const;
        await tx.walletCard.update({
          where: { id: card.id },
          data: { status: 'RETURNED', walletId: null, returnedAt: now, venueId, uid: card.uid ?? uid },
        });
        await recordCardEvents(tx, [{ cardId: card.id, walletId, kind: 'RETURNED' }], { venueId, by, now });
        return { outcome: 'returned', codeHint } as const;
      }
      const fresh = await tx.walletCard.findUnique({ where: { id: card.id }, select: { stockedAt: true } });
      await tx.walletCard.update({
        where: { id: card.id },
        data: {
          // ISSUED sin saldo, o ACTIVE sin saldo del API anterior: al stock.
          ...(card.status === 'ISSUED' || card.status === 'ACTIVE' ? { status: 'STOCK' } : {}),
          venueId,
          uid: card.uid ?? uid,
          stockedAt: fresh?.stockedAt ?? now,
        },
      });
      return fresh?.stockedAt ? ({ outcome: 'already' } as const) : ({ outcome: 'stocked' } as const);
    });
    if (outcome.outcome === 'stocked' || outcome.outcome === 'returned') {
      await this.audit.log({
        action: outcome.outcome === 'stocked' ? 'wallet.card_stocked' : 'wallet.card_returned',
        tenantId: venueId,
        actorId: by.userId,
        targetType: 'WalletCard',
        targetId: input.card.slice(0, 6),
        payload: { withUid: uid !== null, ...(by.terminalId ? { terminalId: by.terminalId } : {}) },
      });
    }
    return outcome;
  }

  // ─── Panel (Clientes → Fichas) ─────────────────────────────────────────

  /** Las fichas de este local, de la más reciente a la más vieja; con búsqueda por número de serie o código. */
  async list(venueId: string, input: { q?: string; status?: string } = {}): Promise<WalletCardRow[]> {
    const status = input.status && isWalletCardStatus(input.status) ? input.status : null;
    const where: Prisma.WalletCardWhereInput = {
      venueId,
      // Un código pedido y aún sin grabar no es una ficha.
      NOT: { status: 'STOCK', stockedAt: null },
      AND: [status ? statusWhere(status) : {}, await this.searchWhere(input.q)],
    };
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.findMany({
        where,
        orderBy: [{ linkedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: LIST_LIMIT,
        include: { wallet: { select: { shortCode: true } } },
      }),
    );
    return rows.map(cardRow);
  }

  /** Número de serie (hex), código del saldo (K7Q-4M2) o primeras letras del código grabado. */
  private async searchWhere(raw: string | undefined): Promise<Prisma.WalletCardWhereInput> {
    const q = (raw ?? '').trim();
    if (!q) return {};
    const hex = q.replace(/[^0-9a-f]/gi, '').toUpperCase();
    const code = normalizeWalletCode(q);
    const or: Prisma.WalletCardWhereInput[] = [{ token: { startsWith: q.slice(0, 64) } }];
    if (hex.length >= 4) or.push({ uid: { contains: hex } });
    if (code.length === 6) {
      const wallets = await this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findMany({ where: { shortCode: code }, select: { id: true }, take: 10 }),
      );
      if (wallets.length > 0) or.push({ walletId: { in: wallets.map((w) => w.id) } });
    }
    return { OR: or };
  }

  /** Cuántas hay ahora y lo de cada noche (congelado en el Z al cerrar; la abierta, en vivo). */
  async summary(venueId: string, now: Date = new Date()): Promise<FichasSummary> {
    const [current, nights] = await Promise.all([
      this.prisma.acrossVenues(async (tx) => ({
        enStock: await tx.walletCard.count({
          where: {
            venueId,
            OR: [{ status: 'RETURNED' }, { status: { in: ['STOCK', 'ACTIVE'] }, walletId: null, stockedAt: { not: null } }],
          },
        }),
        entregadas: await tx.walletCard.count({
          where: { venueId, status: { in: ISSUED_CARD_STATUSES }, walletId: { not: null } },
        }),
      })),
      this.prisma.asSystem((tx) =>
        tx.venueNight.findMany({
          where: { tenantId: venueId },
          orderBy: { openedAt: 'desc' },
          take: SUMMARY_NIGHTS,
          select: { id: true, openedAt: true, closedAt: true, zReport: true },
        }),
      ),
    ]);
    const out: FichasNight[] = [];
    for (const n of nights) {
      const frozen = n.closedAt ? frozenFichas(n.zReport) : null;
      const counts =
        frozen ??
        (await this.prisma.acrossVenues((tx) => fichasCounts(tx, venueId, { from: n.openedAt, to: n.closedAt ?? now })));
      out.push({
        nightId: n.id,
        from: n.openedAt.toISOString(),
        to: n.closedAt?.toISOString() ?? null,
        open: n.closedAt === null,
        entregadas: counts.entregadas,
        devueltas: counts.devueltas,
        perdidas: counts.perdidas,
        // El stock de antes es el que se congeló al cerrar; la abierta, el de ahora.
        enStock: n.closedAt === null ? current.enStock : (frozen?.enStock ?? null),
      });
    }
    return { enStock: current.enStock, entregadas: current.entregadas, nights: out };
  }

  /** Encargado o dueño: bloquear la ficha o marcarla perdida. Ya no paga; el saldo sigue (código + PIN, Face ID). */
  async mark(actor: Actor, cardId: string, action: WalletCardPanelAction): Promise<WalletCardRow> {
    if (actor.role !== 'OWNER' && actor.role !== 'MANAGER') throw new ForbiddenException('Solo el encargado o el dueño');
    const card = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.findUnique({ where: { id: cardId }, include: { wallet: { select: { tenantId: true, walletGroup: true } } } }),
    );
    if (!card || !(await this.cardOfVenue(actor.tenantId, card))) throw new NotFoundException('Ficha no encontrada');
    const problem = cardPanelActionProblem(card.status, action);
    if (problem) throw new ConflictException(problem);
    const now = new Date();
    const res = await this.prisma.acrossVenues(async (tx) => {
      const changed = await tx.walletCard.updateMany({
        where: { id: cardId, status: card.status },
        data: action === 'lost' ? { status: 'LOST', lostAt: now } : { status: 'BLOCKED', blockedAt: now },
      });
      if (changed.count > 0) {
        await recordCardEvents(
          tx,
          [{ cardId, walletId: card.walletId, kind: action === 'lost' ? 'LOST' : 'BLOCKED' }],
          { venueId: actor.tenantId, by: { userId: actor.userId }, now },
        );
      }
      return changed;
    });
    if (res.count === 0) throw new ConflictException('La ficha acaba de cambiar: vuelve a cargar la lista');
    await this.audit.log({
      action: action === 'lost' ? 'wallet.card_lost' : 'wallet.card_blocked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'WalletCard',
      targetId: cardId,
      payload: { from: card.status, walletId: card.walletId },
    });
    const row = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.findUnique({ where: { id: cardId }, include: { wallet: { select: { shortCode: true } } } }),
    );
    if (!row) throw new NotFoundException('Ficha no encontrada');
    return cardRow(row);
  }

  /** La ficha está en este local, o es de un saldo de su grupo. */
  private async cardOfVenue(
    venueId: string,
    card: { venueId: string | null; wallet: { tenantId: string; walletGroup: string | null } | null },
  ): Promise<boolean> {
    if (card.venueId === venueId) return true;
    if (!card.wallet) return false;
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    return sameWalletGroup(card.wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null });
  }

  // ─── Recepción exprés (app del personal) ───────────────────────────────

  /**
   * El NFC acercado (o el código tecleado) en la recepción: nuevo o el saldo
   * que tiene, con su número y lo que se le puede devolver en efectivo. Solo
   * quien carga saldos (recepción, el encargado o el dueño): 403 «Las
   * recargas se hacen en recepción» para el resto. Solo lee.
   */
  async desk(venueId: string, actor: { userId: string; role: Role }, ref: DeskRef): Promise<ReceptionDeskView> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, venueId, actor));
    if ('card' in ref) await this.assertNfc(venueId);
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    return this.prisma.acrossVenues((tx) => readReceptionDesk(tx, { id: venueId, walletGroup: venue?.walletGroup ?? null }, ref));
  }

  private async assertNfc(venueId: string): Promise<void> {
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, venueId, ['nfc']));
  }
}

/**
 * La ficha perdida lo es por sustituida (attachCard / moveWalletCards): su
 * último evento «perdida» lleva el saldo del que se soltó. Las marcadas desde
 * el panel llevan el saldo que tenían en la ficha (ninguno, si estaba en el stock).
 */
async function wasReplaced(tx: Pick<TransactionalClient, 'walletCardEvent'>, cardId: string): Promise<boolean> {
  const last = await tx.walletCardEvent.findFirst({
    where: { cardId, kind: 'LOST' },
    orderBy: { at: 'desc' },
    select: { walletId: true, byUserId: true, terminalId: true },
  });
  return last !== null && last.walletId !== null && last.byUserId === null && last.terminalId === null;
}

/** El filtro del panel por estado (ACTIVE del API anterior: con saldo, entregada; sin él, en stock). */
function statusWhere(status: WalletCardStatus): Prisma.WalletCardWhereInput {
  if (status === 'ISSUED') return { status: { in: ISSUED_CARD_STATUSES }, walletId: { not: null } };
  if (status === 'STOCK') return { OR: [{ status: 'STOCK' }, { status: 'ACTIVE', walletId: null }] };
  return { status };
}

/** El estado para el panel: ACTIVE (API anterior) con saldo es ISSUED, sin él STOCK. */
function panelStatus(c: { status: string; walletId?: string | null }): WalletCardStatus {
  if (c.status === 'ACTIVE') return c.walletId ? 'ISSUED' : 'STOCK';
  return isWalletCardStatus(c.status) ? c.status : 'STOCK';
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

type CardWithWallet = {
  id: string;
  uid: string | null;
  token: string;
  status: string;
  walletId?: string | null;
  stockedAt: Date | null;
  linkedAt: Date | null;
  returnedAt: Date | null;
  lostAt: Date | null;
  blockedAt: Date | null;
  lastUsedAt: Date | null;
  wallet: { shortCode: string | null } | null;
};

/** La ficha para el panel: sin el código grabado entero (solo sus primeras letras). */
export function cardRow(c: CardWithWallet): WalletCardRow {
  const status = panelStatus(c);
  return {
    id: c.id,
    uid: c.uid,
    tokenHint: c.token.slice(0, 6),
    status,
    walletCode: status === 'ISSUED' && c.wallet?.shortCode ? formatWalletCode(c.wallet.shortCode) : null,
    stockedAt: iso(c.stockedAt),
    linkedAt: iso(c.linkedAt),
    returnedAt: iso(c.returnedAt),
    lostAt: iso(c.lostAt),
    blockedAt: iso(c.blockedAt),
    lastUsedAt: iso(c.lastUsedAt),
  };
}
