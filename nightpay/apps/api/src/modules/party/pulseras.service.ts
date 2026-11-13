import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';
import {
  PULSERA_BATCH_MAX,
  isWalletCardStatus,
  parsePulseraNumber,
  pulseraLabel,
  walletCardUrl,
  type PreparedPulseras,
  type PulseraCounts,
  type PulseraRow,
  type PulserasView,
  type ReplacedPulsera,
  type Role,
  type WalletCardStatus,
} from '@nightpay/contracts';
import type { Prisma } from '@nightpay/db';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { operatorAppBaseUrl } from '../operators/operator-app-url';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { ISSUED_CARD_STATUSES, attachCardInTx, isIssuedCard, newCardToken, recordCardEvents } from '../wallets/wallet-card-ops';
import { formatWalletCode, normalizeWalletCode } from '../wallets/wallet-rules';
import { partyBrand } from './party-brand';
import { renderPulseraSheet } from './pulsera-print-page';

type Actor = { userId: string; role: Role; tenantId: string; email?: string };

/** Las de la lista del panel (la más nueva primero). */
const LIST_LIMIT = 100;

const CARD_SELECT = {
  id: true,
  number: true,
  status: true,
  walletId: true,
  venueId: true,
  uid: true,
  token: true,
  stockedAt: true,
  linkedAt: true,
  lastUsedAt: true,
  blockedAt: true,
  lostAt: true,
  wallet: { select: { shortCode: true, balanceCents: true, status: true } },
} as const;

type CardRow = Prisma.WalletCardGetPayload<{ select: typeof CARD_SELECT }>;

/** El estado para el panel (ACTIVE, del API anterior: con saldo, entregada; sin él, en el stock). */
function panelStatus(c: { status: string; walletId: string | null }): WalletCardStatus {
  if (c.status === 'ACTIVE') return c.walletId ? 'ISSUED' : 'STOCK';
  return isWalletCardStatus(c.status) ? c.status : 'STOCK';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Una pulsera para el panel: nunca el código grabado (es lo que paga). */
export function pulseraRow(c: CardRow): PulseraRow {
  const status = panelStatus(c);
  const withWallet = c.walletId !== null && c.wallet !== null && status !== 'STOCK' && status !== 'RETURNED';
  return {
    id: c.id,
    number: c.number,
    label: pulseraLabel(c.number),
    status,
    walletCode: withWallet && c.wallet?.shortCode ? formatWalletCode(c.wallet.shortCode) : null,
    balanceCents: withWallet && c.wallet?.status === 'ACTIVE' ? c.wallet.balanceCents : null,
    hasUid: c.uid !== null,
    stockedAt: iso(c.stockedAt),
    linkedAt: iso(c.linkedAt),
    lastUsedAt: iso(c.lastUsedAt),
    blockedAt: iso(c.blockedAt),
    lostAt: iso(c.lostAt),
  };
}

/** Recuento por estado (las filas agrupadas de wallet_cards). */
export function pulseraCounts(groups: ReadonlyArray<{ status: string; n: number }>): PulseraCounts {
  const counts: PulseraCounts = { STOCK: 0, ISSUED: 0, RETURNED: 0, LOST: 0, BLOCKED: 0, total: 0 };
  for (const g of groups) {
    const s = isWalletCardStatus(g.status) ? g.status : 'STOCK';
    counts[s] += g.n;
    counts.total += g.n;
  }
  return counts;
}

/** El rango de la hoja: «desde» y «hasta» (números o «P-0412»), como mucho PULSERA_BATCH_MAX. */
export function sheetRange(desde: string | undefined, hasta: string | undefined): { from: number; to: number } {
  const from = parsePulseraNumber(desde);
  const to = parsePulseraNumber(hasta ?? desde);
  if (from === null || to === null) throw new BadRequestException('Di de qué número a qué número (P-0001 a P-0100)');
  if (to < from) throw new BadRequestException('El primer número tiene que ser el menor');
  if (to - from + 1 > PULSERA_BATCH_MAX) throw new BadRequestException(`Como mucho ${PULSERA_BATCH_MAX} pulseras por hoja`);
  return { from, to };
}

/** Un código pedido y aún sin grabar (stock sin stockedAt) no es una pulsera. */
const NOT_PENDING_CODE: Prisma.WalletCardWhereInput = { NOT: { status: 'STOCK', stockedAt: null } };

/**
 * Las que salen en la hoja para imprimir: sin entregar (en el stock o
 * devueltas, sin saldo). El QR lleva el enlace del saldo: el de una entregada
 * es el de un asistente, y no se imprime.
 */
export const SHEET_PRINTABLE: Prisma.WalletCardWhereInput = { walletId: null, status: { in: ['STOCK', 'RETURNED'] } };

/**
 * Las pulseras de OxioParty en el panel (Pulseras): son las fichas NFC del
 * saldo (wallet_cards, sin RLS: el local va siempre explícito, venueId).
 *  - Preparar N de una vez: N códigos nuevos, ya en el stock del local (se
 *    graban en el chip y se imprimen con su QR fuera de aquí).
 *  - Recuento por estado y buscador por número (o por el código del saldo).
 *  - La hoja para imprimir: número y QR (el mismo enlace del chip).
 *  - Perdida: se bloquea (ya no paga) y su saldo pasa a otra del stock, la
 *    misma operación de siempre (attachCardInTx: el saldo vive en el saldo, no
 *    en la pulsera).
 */
@Injectable()
export class PulserasService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async view(tenantId: string, input: { q?: string; status?: string } = {}): Promise<PulserasView> {
    const status = input.status && isWalletCardStatus(input.status) ? input.status : null;
    return this.prisma.acrossVenues(async (tx) => {
      const groups = await tx.$queryRaw<Array<{ status: string; n: number }>>`
        SELECT CASE WHEN status = 'ACTIVE' THEN CASE WHEN "walletId" IS NULL THEN 'STOCK' ELSE 'ISSUED' END ELSE status END AS status,
               COUNT(*)::int AS n
          FROM wallet_cards
         WHERE "venueId" = ${tenantId}::uuid AND NOT (status = 'STOCK' AND "stockedAt" IS NULL)
         GROUP BY 1
      `;
      const rows = await tx.walletCard.findMany({
        where: { venueId: tenantId, AND: [NOT_PENDING_CODE, status ? statusWhere(status) : {}, await searchWhere(tx, input.q)] },
        orderBy: { number: 'desc' },
        take: LIST_LIMIT,
        select: CARD_SELECT,
      });
      return { counts: pulseraCounts(groups), rows: rows.map(pulseraRow) };
    });
  }

  /** N pulseras nuevas en el stock del local, de una vez (números seguidos si nadie prepara a la vez). */
  async prepare(actor: Actor, count: number, now: Date = new Date()): Promise<PreparedPulseras> {
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, actor.tenantId, ['nfc']));
    const tokens = Array.from({ length: count }, () => newCardToken());
    const made = await this.prisma.acrossVenues(async (tx) => {
      await tx.walletCard.createMany({
        data: tokens.map((token) => ({ token, status: 'STOCK', venueId: actor.tenantId, linkedById: actor.userId, stockedAt: now })),
      });
      return tx.walletCard.aggregate({ where: { token: { in: tokens } }, _min: { number: true }, _max: { number: true }, _count: { _all: true } });
    });
    const first = made._min.number ?? 0;
    const last = made._max.number ?? 0;
    await this.audit.log({
      action: 'party.pulseras.prepared',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: 'Venue',
      targetId: actor.tenantId,
      payload: { count: made._count._all, first, last },
    });
    return { count: made._count._all, first, last, firstLabel: pulseraLabel(first), lastLabel: pulseraLabel(last) };
  }

  /** La hoja para imprimir: las pulseras sin entregar del local de un número a otro, con su QR. */
  async sheet(tenantId: string, range: { from: number; to: number }): Promise<string> {
    const base = operatorAppBaseUrl({
      operatorBaseUrl: this.config.get<string>('OPERATOR_BASE_URL'),
      operatorUrl: this.config.get<string>('NEXT_PUBLIC_OPERATOR_URL'),
      apiUrl: this.config.get<string>('NEXT_PUBLIC_API_URL'),
      production: this.config.get<string>('NODE_ENV') === 'production',
    });
    if (!base) throw new ServiceUnavailableException('Falta la dirección de la app del personal: configura OPERATOR_BASE_URL');
    const [venue, cards] = await Promise.all([
      this.prisma.venue.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.prisma.acrossVenues((tx) =>
        tx.walletCard.findMany({
          where: { venueId: tenantId, number: { gte: range.from, lte: range.to }, AND: [NOT_PENDING_CODE, SHEET_PRINTABLE] },
          orderBy: { number: 'asc' },
          select: { number: true, token: true },
        }),
      ),
    ]);
    if (cards.length === 0) throw new NotFoundException('No hay pulseras sin entregar de este local con esos números');
    const pulseras = await Promise.all(
      cards.map(async (c) => ({
        label: pulseraLabel(c.number),
        qrSvg: await QRCode.toString(walletCardUrl(base, c.token), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#14181B', light: '#FFFFFF' } }),
      })),
    );
    return renderPulseraSheet({ brand: partyBrand(), venueName: venue?.name ?? '', pulseras });
  }

  /**
   * Perdida: la pulsera se bloquea (ya no paga, tampoco sin PIN) y su saldo
   * pasa a otra del stock del local (por su número). El saldo no se toca:
   * vive en el saldo, la pulsera solo dice de quién es.
   */
  async replace(actor: Actor, cardId: string, nueva: string): Promise<ReplacedPulsera> {
    const newNumber = parsePulseraNumber(nueva);
    if (newNumber === null) throw new BadRequestException('Escribe el número de la pulsera nueva (P-0413)');
    const by = { userId: actor.userId };
    const out = await this.prisma.acrossVenues(async (tx) => {
      const old = await tx.walletCard.findUnique({ where: { id: cardId }, select: CARD_SELECT });
      if (!old || old.venueId !== actor.tenantId) throw new NotFoundException('Pulsera no encontrada');
      if (!old.walletId) throw new ConflictException('Esta pulsera no está dada a nadie: no hay saldo que pasar');
      const fresh = await tx.walletCard.findUnique({ where: { number: newNumber }, select: CARD_SELECT });
      if (!fresh || fresh.venueId !== actor.tenantId) throw new NotFoundException(`No hay ninguna pulsera ${pulseraLabel(newNumber)} en este local`);
      if (fresh.id === old.id) throw new ConflictException('La nueva tiene que ser otra pulsera');
      if (fresh.walletId || !['STOCK', 'RETURNED'].includes(fresh.status) || (fresh.status === 'STOCK' && !fresh.stockedAt)) {
        throw new ConflictException(`La pulsera ${pulseraLabel(newNumber)} no está libre en el stock: usa otra`);
      }
      // Siempre en este orden (saldo, pulsera): el mismo que al dar una.
      const locked = await tx.$queryRaw<Array<{ status: string; balanceCents: number; mergedIntoId: string | null }>>`
        SELECT status::text AS status, "balanceCents", "mergedIntoId" FROM client_wallets WHERE id = ${old.walletId}::uuid FOR UPDATE
      `;
      const wallet = locked[0];
      if (!wallet) throw new NotFoundException('Saldo no encontrado');
      if (wallet.status === 'REFUNDED' || wallet.mergedIntoId) throw new ConflictException('El saldo de esa pulsera ya está cerrado: no hay nada que pasar');
      const now = new Date();
      if (isIssuedCard(old)) {
        const changed = await tx.walletCard.updateMany({
          where: { id: old.id, status: { in: ISSUED_CARD_STATUSES } },
          data: { status: 'BLOCKED', blockedAt: now },
        });
        if (changed.count > 0) await recordCardEvents(tx, [{ cardId: old.id, walletId: old.walletId, kind: 'BLOCKED' }], { venueId: actor.tenantId, by, now });
      }
      await attachCardInTx(tx as TransactionalClient, { walletId: old.walletId, venueId: actor.tenantId, card: fresh.token, uid: null, by });
      const [from, to] = await Promise.all([
        tx.walletCard.findUniqueOrThrow({ where: { id: old.id }, select: CARD_SELECT }),
        tx.walletCard.findUniqueOrThrow({ where: { id: fresh.id }, select: CARD_SELECT }),
      ]);
      return { from, to, balanceCents: wallet.balanceCents, walletId: old.walletId };
    });
    await this.audit.log({
      action: 'party.pulsera.replaced',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: 'ClientWallet',
      targetId: out.walletId,
      payload: { from: out.from.number, to: out.to.number, balanceCents: out.balanceCents },
    });
    return { from: pulseraRow(out.from), to: pulseraRow(out.to), balanceCents: out.balanceCents };
  }
}

/** El filtro por estado (ACTIVE del API anterior: con saldo, entregada; sin él, en el stock). */
function statusWhere(status: WalletCardStatus): Prisma.WalletCardWhereInput {
  if (status === 'ISSUED') return { status: { in: ISSUED_CARD_STATUSES }, walletId: { not: null } };
  if (status === 'STOCK') return { OR: [{ status: 'STOCK' }, { status: 'ACTIVE', walletId: null }] };
  return { status };
}

/** «P-0412» / «412» → ese número; K7Q-4M2 → las pulseras de ese saldo; otra cosa → nada. */
async function searchWhere(tx: TransactionalClient, raw: string | undefined): Promise<Prisma.WalletCardWhereInput> {
  const q = (raw ?? '').trim().slice(0, 32);
  if (!q) return {};
  const or: Prisma.WalletCardWhereInput[] = [];
  const n = parsePulseraNumber(q);
  if (n !== null) or.push({ number: n });
  const code = normalizeWalletCode(q);
  if (code.length === 6 && /[A-Z]/.test(code)) {
    const wallets = await tx.clientWallet.findMany({ where: { shortCode: code }, select: { id: true }, take: 10 });
    if (wallets.length > 0) or.push({ walletId: { in: wallets.map((w) => w.id) } });
  }
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}
