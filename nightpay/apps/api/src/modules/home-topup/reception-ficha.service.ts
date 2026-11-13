import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FICHA_PROOF_REQUIRED_CODE,
  LOST_FICHA_FEE_CHANGED_CODE,
  LOST_FICHA_NO_BALANCE_CODE,
  isWalletCardToken,
  nightSettingsOf,
  normalizeWalletCardUid,
  type GiveFichaDto,
  type GiveFichaVia,
  type GivenFicha,
  type ReplaceLostFichaDto,
  type ReplacedFicha,
  type Role,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { isPartyEdition } from '../../config/edition';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { assertEventOpen } from '../party/event-window';
import { stallIdForStaff, stallSeal } from '../party/stall-seal';
import { ISSUED_CARD_STATUSES, attachCardInTx, isIssuedCard } from '../wallets/wallet-card-ops';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { FichaNumbersService } from '../wallets/ficha-numbers.service';
import { serviceFeeSaldoCents, serviceFeeSpendCents, saldoCredits } from '../wallets/wallet-fee-saldo';
import { lockLiveWallet } from '../wallets/wallet-merge-chain';
import { formatWalletCode, sameWalletGroup } from '../wallets/wallet-rules';
import { fichaProofValid } from './ficha-qr';

export interface FichaActor {
  userId: string;
  role: Role;
  tenantId: string;
}

const LIVE = new Set(['ACTIVE', 'DEPLETED']);

/**
 * Recepción da una ficha (NFC) unida a un saldo que aún no tiene: el que
 * el cliente cargó desde casa (o cualquier otro sin ficha). Con los mismos
 * permisos que las demás operaciones de recepción (assertCanTopUp: el puesto
 * de recepción, el encargado o el dueño) y con «Fichas NFC» encendido.
 *
 * Una ficha con saldo paga sin PIN los importes pequeños («Noche fácil»):
 * por eso el cliente prueba que el saldo es suyo, con UNA de estas:
 *  - el QR de su saldo (lo enseña su móvil: una prueba firmada por el servidor
 *    que solo ve quien tiene el saldo; ficha-qr.ts), o
 *  - su PIN (tecleado en el móvil de recepción, con su contador de fallos).
 * El encargado y el dueño no necesitan ninguna (como al dar ficha hoy).
 * Solo la PRIMERA ficha: si el saldo ya tuvo una (aunque se perdiera o se
 * bloqueara), recepción no le da otra; el encargado, sí (como siempre). Con
 * una dada ahora, nadie aquí (se cambia en «Darle una ficha»). Queda en el
 * registro con cómo se dio.
 */
@Injectable()
export class ReceptionFichaService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(FichaNumbersService) private readonly numbers: FichaNumbersService,
  ) {}

  async give(actor: FichaActor, input: GiveFichaDto): Promise<GivenFicha> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, { userId: actor.userId, role: actor.role }));
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, actor.tenantId, ['nfc']));
    if (!isWalletCardToken(input.card)) throw new BadRequestException('Esta ficha no es nuestra: grábala otra vez');
    const wallet = await this.liveWallet(actor.tenantId, input.walletId);
    const manager = actor.role === 'MANAGER' || actor.role === 'OWNER';
    // La misma ficha leída otra vez (B5: se lee sola): ya es de este saldo; no pasa nada.
    if (await this.prisma.acrossVenues((tx) => cardIsOf(tx, input.card, wallet.id))) {
      return this.givenView(wallet, await this.proofOf(actor, wallet, input));
    }
    // Antes de gastar un intento de su PIN: ya con ficha (o, recepción, si ya tuvo una), no.
    await this.prisma.acrossVenues((tx) => assertFirstFicha(tx, wallet.id, manager));
    const via = await this.proofOf(actor, wallet, input);
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const replaced = await this.prisma.acrossVenues(async (tx) => {
      // Con el saldo bloqueado y otra vez la regla: de dos «dar ficha» a la vez, una (la otra no sustituye a la primera).
      await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      await assertFirstFicha(tx, wallet.id, manager);
      if (input.onlyStock) await assertFreeCard(tx, input.card);
      return attachCardInTx(tx, { walletId: wallet.id, venueId: actor.tenantId, card: input.card, uid, by: { userId: actor.userId } });
    });
    await this.audit.log({
      action: 'wallet.card_linked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { replacedCards: replaced, withUid: uid !== null, where: 'reception', via, ...(input.onlyStock ? { onlyStock: true } : {}) },
    });
    return this.givenView(wallet, via);
  }

  /** Lo que ve recepción tras darla: el saldo, su código y el número de su ficha. */
  private async givenView(wallet: { id: string; shortCode: string | null; balanceCents: number }, via: GiveFichaVia): Promise<GivenFicha> {
    const card = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.findFirst({
        where: { walletId: wallet.id, status: { in: ISSUED_CARD_STATUSES } },
        orderBy: { linkedAt: { sort: 'desc', nulls: 'last' } },
        select: { number: true, printedNumber: true },
      }),
    );
    return {
      walletId: wallet.id,
      code: formatWalletCode(wallet.shortCode ?? ''),
      balanceCents: wallet.balanceCents,
      fichaNumber: card?.number ?? null,
      ...(card?.printedNumber ? { printedNumber: card.printedNumber } : {}),
      via,
    };
  }

  /**
   * «Ficha perdida» en recepción (B6). Con una prueba de que el saldo es suyo
   * (su QR, o su PIN tras buscarlo por su código o por el número de la ficha
   * perdida; el encargado y el dueño, sin prueba), la ficha nueva queda unida
   * a su saldo, la vieja deja de pagar (attachCardInTx la da por perdida) y la
   * nueva se cobra del saldo (Ajustes → Noche): todo en la misma operación.
   * Si el saldo no llega, se dice y no se hace nada (ni se gasta su PIN).
   */
  async replaceLost(actor: FichaActor, input: ReplaceLostFichaDto): Promise<ReplacedFicha> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, { userId: actor.userId, role: actor.role }));
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, actor.tenantId, ['nfc']));
    if (!isWalletCardToken(input.card)) throw new BadRequestException('Esta ficha no es nuestra: grábala otra vez');
    const walletId = input.walletId ?? (await this.numbers.walletIdByNumber(actor.tenantId, input.printedNumber ?? ''));
    const wallet = await this.liveWallet(actor.tenantId, walletId);
    const fee = await this.lostFichaFee(actor.tenantId);
    if (input.feeCents !== fee) {
      throw new ConflictException({ message: `La ficha nueva cuesta ahora ${eur(fee)}: díselo y vuelve a confirmarlo.`, code: LOST_FICHA_FEE_CHANGED_CODE, feeCents: fee });
    }
    // Antes de gastar un intento de su PIN: con ficha que perder y con saldo para la nueva.
    await this.prisma.acrossVenues((tx) => assertHasFicha(tx, wallet.id));
    if (wallet.balanceCents < fee) throw noBalance(wallet.balanceCents, fee);
    // OxioParty: cobrar la nueva es un consumo; con la fiesta terminada, no (423 EVENT_ENDED).
    if (fee > 0 && isPartyEdition()) await this.prisma.asSystem((tx) => assertEventOpen(tx, actor.tenantId));
    const via = await this.proofOf(actor, wallet, input);
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const out = await this.prisma.acrossVenues(async (tx) => {
      const w = await lockLiveWallet(tx, wallet.id);
      if (!w || w.id !== wallet.id) throw new ConflictException('Este saldo acaba de cambiar: búscalo otra vez');
      // La misma ficha nueva otra vez (se cortó la respuesta): ya está, sin cobrarla dos veces.
      const again = await tx.walletCard.findUnique({ where: { token: input.card }, select: { walletId: true, status: true } });
      if (again?.walletId === w.id && again.status === 'ISSUED') return { replaced: 0, charged: 0, balanceCents: w.balanceCents };
      await assertHasFicha(tx, w.id);
      if (w.balanceCents < fee) throw noBalance(w.balanceCents, fee);
      const replaced = await attachCardInTx(tx, { walletId: w.id, venueId: actor.tenantId, card: input.card, uid, by: { userId: actor.userId } });
      if (fee > 0) await chargeLostFicha(tx, { actor, walletId: w.id, balanceCents: w.balanceCents, fee, via, card: input.card });
      return { replaced, charged: fee, balanceCents: w.balanceCents - fee };
    });
    await this.audit.log({
      action: 'wallet.card_replaced_lost',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { replacedCards: out.replaced, feeCents: out.charged, withUid: uid !== null, via, by: input.walletId ? 'saldo' : 'numero' },
    });
    const card = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.findUnique({ where: { token: input.card }, select: { number: true, printedNumber: true } }),
    );
    return {
      balanceCents: out.balanceCents,
      feeCents: out.charged,
      fichaNumber: card?.number ?? null,
      ...(card?.printedNumber ? { printedNumber: card.printedNumber } : {}),
      replacedCards: out.replaced,
      via,
    };
  }

  /** Lo que cuesta la ficha nueva en este local (Ajustes → Noche). */
  private async lostFichaFee(venueId: string): Promise<number> {
    const venue = await this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: venueId }, select: { nightSettings: true } }));
    return nightSettingsOf(venue?.nightSettings).lostFichaFeeCents;
  }

  /** El saldo, si vale en este local (vivo, de su grupo, sin bloquear ni pendiente). */
  private async liveWallet(venueId: string, walletId: string) {
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({
          where: { id: walletId },
          select: {
            id: true,
            tenantId: true,
            qrToken: true,
            walletGroup: true,
            shortCode: true,
            status: true,
            balanceCents: true,
            blockedAt: true,
            mergedIntoId: true,
            closeRequestedAt: true,
            pendingAssignAt: true,
          },
        }),
      ),
      this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } })),
    ]);
    if (!wallet || !sameWalletGroup(wallet, { id: venueId, walletGroup: venue?.walletGroup ?? null })) {
      throw new NotFoundException('No hay ningún saldo así en este local');
    }
    if (wallet.mergedIntoId) throw new ConflictException('Este saldo se sumó a otro: busca el otro con su código');
    if (wallet.blockedAt) throw new ConflictException('Este saldo está bloqueado: avisa al encargado');
    if (!LIVE.has(wallet.status)) throw new ConflictException('Este saldo ya está cerrado (devuelto): haz un saldo nuevo');
    if (wallet.pendingAssignAt) throw new ConflictException('Es una recarga pendiente de asignar: asígnala antes a su saldo');
    if (wallet.closeRequestedAt) throw new ConflictException('Ha pedido que le devuelvan el saldo: no se le da ficha');
    return wallet;
  }

  /** Cómo prueba el cliente que el saldo es suyo: su QR o su PIN (el encargado, sin prueba). */
  private async proofOf(actor: FichaActor, wallet: { id: string; qrToken: string }, input: Pick<GiveFichaDto, 'proof' | 'pin'>): Promise<GiveFichaVia> {
    if (input.proof !== undefined) {
      // Atada a su enlace de ahora: tras un enlace nuevo del dueño, la de antes no vale.
      if (!fichaProofValid(this.config.get<string>('COOKIE_SECRET') ?? '', wallet, input.proof)) {
        throw new UnprocessableEntityException({
          message: 'Ese QR no es el de este saldo: que lo abra otra vez en su móvil',
          code: 'FICHA_PROOF_WRONG',
        });
      }
      return 'qr';
    }
    if (input.pin !== undefined) {
      // El de siempre: con el saldo bloqueado, cuenta los fallos (5 → bloqueado) y quién lo tecleó.
      await this.charges.checkPinForPayout(actor, wallet.id, input.pin);
      return 'pin';
    }
    if (actor.role === 'MANAGER' || actor.role === 'OWNER') return 'manager';
    throw new UnprocessableEntityException({
      message: 'Para darle la ficha, que te enseñe el QR de su saldo o que ponga su PIN',
      code: FICHA_PROOF_REQUIRED_CODE,
    });
  }
}

const eur = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '')} €`;

/** ¿Esta ficha ya está dada a este saldo? (la misma, leída otra vez). */
async function cardIsOf(tx: Pick<TransactionalClient, 'walletCard'>, token: string, walletId: string): Promise<boolean> {
  const card = await tx.walletCard.findUnique({ where: { token }, select: { walletId: true, status: true } });
  return card !== null && isIssuedCard(card) && card.walletId === walletId;
}

/**
 * B5: solo una ficha nueva o del stock. La de otro saldo no, aunque esté
 * gastado (attachCardInTx la dejaría pasar si ya no tiene dinero).
 */
async function assertFreeCard(tx: Pick<TransactionalClient, 'walletCard'>, token: string): Promise<void> {
  const card = await tx.walletCard.findUnique({ where: { token }, select: { walletId: true, status: true } });
  if (card && isIssuedCard(card)) {
    throw new ConflictException({ message: 'Esa ficha es de otro saldo (aunque esté gastado): usa una nueva o del stock.', code: 'FICHA_NOT_FREE' });
  }
}

/** 409 si el saldo no cubre la ficha nueva: se dice y no se hace nada. */
function noBalance(balanceCents: number, fee: number): ConflictException {
  return new ConflictException({
    message: `No le llega el saldo: le quedan ${eur(balanceCents)} y la ficha nueva cuesta ${eur(fee)}. Que cargue antes.`,
    code: LOST_FICHA_NO_BALANCE_CODE,
    feeCents: fee,
  });
}

/** La ficha perdida es la que tiene ahora: sin ficha dada, esto es «Dar ficha a un saldo» (sin cobrar). */
async function assertHasFicha(tx: Pick<TransactionalClient, 'walletCard'>, walletId: string): Promise<void> {
  const issued = await tx.walletCard.count({ where: { walletId, status: { in: ISSUED_CARD_STATUSES } } });
  if (issued === 0) throw new ConflictException('Este saldo no tiene ficha: dásela con «Dar ficha a un saldo» (sin cobrar).');
}

/**
 * La ficha nueva, del saldo: un consumo de recepción (sección Entradas, «Ficha
 * nueva») como cualquier gasto del saldo, con el saldo ya bloqueado. A 0, el
 * saldo queda gastado (DEPLETED), como al pagar.
 */
async function chargeLostFicha(
  tx: TransactionalClient,
  a: { actor: FichaActor; walletId: string; balanceCents: number; fee: number; via: GiveFichaVia; card: string },
): Promise<void> {
  const venue = await tx.venue.findUnique({ where: { id: a.actor.tenantId }, select: { platformCommissionBps: true } });
  const feeSaldo = serviceFeeSaldoCents({
    amountCents: a.fee,
    tipCents: 0,
    feeSpendCents: serviceFeeSpendCents(await saldoCredits(tx, a.walletId), a.balanceCents, a.fee),
  });
  const left = a.balanceCents - a.fee;
  await tx.clientWallet.update({
    where: { id: a.walletId },
    data: { balanceCents: { decrement: a.fee }, ...(left === 0 ? { status: 'DEPLETED' as const } : {}) },
  });
  await tx.walletConsumption.create({
    data: {
      tenantId: a.actor.tenantId,
      walletId: a.walletId,
      amountCents: a.fee,
      providedByUserId: a.actor.userId,
      category: 'VENUE_ENTRY',
      notes: 'Ficha nueva (perdida la anterior)',
      idempotencyKey: `ficha-perdida:${a.card}`,
      authMethod: a.via === 'pin' ? 'pin' : 'staff',
      ...(feeSaldo > 0 ? { serviceFeeSaldoCents: feeSaldo } : {}),
      ...(venue ? { platformCommissionBps: venue.platformCommissionBps } : {}),
      // OxioParty: la caseta de quien la cobra, si tiene (OxioPay: nada).
      ...stallSeal(await stallIdForStaff(tx, { tenantId: a.actor.tenantId, userId: a.actor.userId })),
    },
  });
}

/**
 * Con una ficha dada ahora, no (se cambia en «Darle una ficha»). Recepción,
 * además, solo la primera: si el saldo ya tuvo una (perdida, bloqueada o
 * sustituida), la siguiente la da el encargado.
 */
async function assertFirstFicha(
  tx: Pick<TransactionalClient, 'walletCard' | 'walletCardEvent'>,
  walletId: string,
  manager: boolean,
): Promise<void> {
  const issued = await tx.walletCard.findFirst({
    where: { walletId, status: { in: ISSUED_CARD_STATUSES } },
    select: { number: true, printedNumber: true },
  });
  if (issued) {
    throw new ConflictException(`Este saldo ya tiene ficha (nº ${issued.printedNumber ?? issued.number}). Si la ha perdido, el encargado le da otra.`);
  }
  if (manager) return;
  const [cards, events] = await Promise.all([
    tx.walletCard.count({ where: { walletId } }),
    tx.walletCardEvent.count({ where: { walletId } }),
  ]);
  if (cards > 0 || events > 0) throw new ConflictException('Este saldo ya tuvo ficha: la siguiente se la da el encargado.');
}
