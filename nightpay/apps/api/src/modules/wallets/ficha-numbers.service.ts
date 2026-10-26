import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  NEW_FICHA_BY_NUMBER_MESSAGE,
  maskedWalletCode,
  normalizePrintedFichaNumber,
  type ReceptionNumberTopUpDto,
  type ReceptionNumberTopUpResult,
  type ReceptionNumberView,
  type Role,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { PRINTED_NUMBER_INVALID, printedLookupScopes } from './ficha-numbers';
import { LIVE_WALLET_STATUSES, liveWallet, type DeskWallet } from './reception-desk';
import { cardInGroup, cardUnusableText, isIssuedCard } from './wallet-card-ops';
import { CashTopUpService } from './wallet-cash-topup.service';
import { cashPayoutCapCents, cashPayoutNote, walletCash } from './wallet-cash-limits';
import { sameWalletGroup } from './wallet-rules';

type Actor = { userId: string; role: Role; tenantId: string };

/** La ficha buscada por su número: dada a un saldo vivo, o no (del stock, nueva o de un saldo cerrado). */
type Found = { cardId: string; wallet: DeskWallet | null };

/**
 * Recepción busca una ficha por su número impreso (sin acercarla: un iPhone,
 * un NFC que no se lee). El número se lee en la propia ficha, así que no
 * prueba nada: se ve solo un resumen sin nada que sirva para pagar (ni el
 * código del saldo, ni su id) y solo se recargan en efectivo saldos que ya
 * existen. Una ficha nueva se carga acercándola (así sale con su saldo).
 * Cada búsqueda queda en el registro; el tope por persona va en la ruta.
 */
@Injectable()
export class FichaNumbersService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly cash: CashTopUpService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(CashTopUpService) cash: CashTopUpService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.cash = cash;
  }

  async lookup(actor: Actor, printedNumber: string): Promise<ReceptionNumberView> {
    await this.assertReception(actor);
    const found = await this.find(actor.tenantId, printedNumber).catch(async (err: unknown) => {
      await this.logLookup(actor, printedNumber, { result: 'not_found' });
      throw err;
    });
    const view = await this.view(actor.tenantId, printedNumber, found);
    await this.logLookup(actor, printedNumber, { result: view.kind, cardId: found.cardId });
    return view;
  }

  /** Recarga en efectivo del saldo de la ficha buscada por su número (no una nueva). */
  async topUp(actor: Actor, input: ReceptionNumberTopUpDto): Promise<ReceptionNumberTopUpResult> {
    await this.assertReception(actor);
    const found = await this.find(actor.tenantId, input.printedNumber);
    if (!found.wallet) throw new ConflictException({ message: NEW_FICHA_BY_NUMBER_MESSAGE, code: 'NEW_FICHA_NEEDS_TAP' });
    const out = await this.cash.topUp(actor.tenantId, { userId: actor.userId, role: actor.role }, {
      amountCents: input.amountCents,
      idempotencyKey: input.idempotencyKey,
      wallet: { printed: { cardId: found.cardId } },
      ...(input.serviceFeeCents !== undefined ? { serviceFeeCents: input.serviceFeeCents } : {}),
    });
    return {
      topUpId: out.topUpId,
      codeHint: maskedWalletCode(out.code),
      amountCents: out.amountCents,
      serviceFeeCents: out.serviceFeeCents ?? 0,
      balanceCents: out.balanceCents,
      replayed: out.replayed,
    };
  }

  /** Solo quien carga saldos (recepción, el encargado o el dueño), con las fichas NFC encendidas. */
  private async assertReception(actor: Actor): Promise<void> {
    await this.prisma.asSystem(async (tx) => {
      await assertCanTopUp(tx, actor.tenantId, actor);
      await assertVenueAcceptsMethods(tx, actor.tenantId, ['nfc']);
    });
  }

  private async find(venueId: string, printedNumber: string): Promise<Found> {
    const norm = normalizePrintedFichaNumber(printedNumber);
    if (!norm) throw new BadRequestException(PRINTED_NUMBER_INVALID);
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    const here = { id: venueId, walletGroup: venue?.walletGroup ?? null };
    return this.prisma.acrossVenues(async (tx) => {
      const cards = await tx.walletCard.findMany({
        where: { printedNumberNorm: norm, printedScope: { in: printedLookupScopes(here) } },
        select: { id: true, walletId: true, status: true, venueId: true },
        take: 2,
      });
      const inGroup = [];
      for (const c of cards) if (await cardInGroup(tx, c, venueId)) inGroup.push(c);
      if (inGroup.length === 0) throw new NotFoundException('No hay ninguna ficha con ese número en este local');
      if (inGroup.length > 1) throw new ConflictException('Hay dos fichas con ese número: acércala para saber cuál es');
      const card = inGroup[0]!;
      const unusable = cardUnusableText(card.status);
      if (unusable) throw new ConflictException(unusable);
      const wallet = isIssuedCard(card) && card.walletId ? await liveWallet(tx, card.walletId) : null;
      const live = wallet && LIVE_WALLET_STATUSES.has(wallet.status) && sameWalletGroup(wallet, here) ? wallet : null;
      return { cardId: card.id, wallet: live };
    });
  }

  private async view(venueId: string, printedNumber: string, found: Found): Promise<ReceptionNumberView> {
    const w = found.wallet;
    if (!w) return { kind: 'new', printedNumber };
    const cash = await this.prisma.acrossVenues((tx) => walletCash(tx, w.id));
    return {
      kind: 'saldo',
      printedNumber,
      codeHint: maskedWalletCode(w.shortCode ?? ''),
      balanceCents: w.balanceCents,
      cashOutCents: cashPayoutCapCents(w.balanceCents, cash),
      cashOutNote: cashPayoutNote(w.balanceCents, cash),
      hasPin: w.pinHash !== null,
      blocked: w.blockedAt !== null,
      closeRequested: w.closeRequestedAt !== null,
      isHomeVenue: w.tenantId === venueId,
    };
  }

  private async logLookup(actor: Actor, printedNumber: string, payload: { result: string; cardId?: string }): Promise<void> {
    await this.audit.log({
      action: 'wallet.card_number_lookup', tenantId: actor.tenantId, actorId: actor.userId,
      targetType: 'WalletCard', targetId: payload.cardId ?? printedNumber,
      payload: { printedNumber, result: payload.result },
    });
  }
}
