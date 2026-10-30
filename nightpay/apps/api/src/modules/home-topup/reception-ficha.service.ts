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
  isWalletCardToken,
  normalizeWalletCardUid,
  type GiveFichaDto,
  type GiveFichaVia,
  type GivenFicha,
  type Role,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { ISSUED_CARD_STATUSES, attachCardInTx } from '../wallets/wallet-card-ops';
import { WalletChargesService } from '../wallets/wallet-charges.service';
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
  ) {}

  async give(actor: FichaActor, input: GiveFichaDto): Promise<GivenFicha> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, { userId: actor.userId, role: actor.role }));
    await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, actor.tenantId, ['nfc']));
    if (!isWalletCardToken(input.card)) throw new BadRequestException('Esta ficha no es nuestra: grábala otra vez');
    const wallet = await this.liveWallet(actor.tenantId, input.walletId);
    const manager = actor.role === 'MANAGER' || actor.role === 'OWNER';
    // Antes de gastar un intento de su PIN: ya con ficha (o, recepción, si ya tuvo una), no.
    await this.prisma.acrossVenues((tx) => assertFirstFicha(tx, wallet.id, manager));
    const via = await this.proofOf(actor, wallet, input);
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const replaced = await this.prisma.acrossVenues(async (tx) => {
      // Con el saldo bloqueado y otra vez la regla: de dos «dar ficha» a la vez, una (la otra no sustituye a la primera).
      await tx.$queryRaw`SELECT id FROM client_wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      await assertFirstFicha(tx, wallet.id, manager);
      return attachCardInTx(tx, { walletId: wallet.id, venueId: actor.tenantId, card: input.card, uid, by: { userId: actor.userId } });
    });
    await this.audit.log({
      action: 'wallet.card_linked',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: { replacedCards: replaced, withUid: uid !== null, where: 'reception', via },
    });
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
  private async proofOf(actor: FichaActor, wallet: { id: string; qrToken: string }, input: GiveFichaDto): Promise<GiveFichaVia> {
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
