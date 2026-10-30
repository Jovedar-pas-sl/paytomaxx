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
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { assertCanTopUp } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { ISSUED_CARD_STATUSES, attachCard } from '../wallets/wallet-card-ops';
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
 * Solo la PRIMERA ficha: con una ya dada, recepción no da otra (el encargado,
 * como siempre, en «Darle una ficha»). Queda en el registro con cómo se dio.
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
    const wallet = await this.walletWithoutFicha(actor.tenantId, input.walletId);
    const via = await this.proofOf(actor, wallet.id, input);
    const uid = input.uid ? normalizeWalletCardUid(input.uid) : null;
    const replaced = await attachCard(this.prisma, {
      walletId: wallet.id,
      venueId: actor.tenantId,
      card: input.card,
      uid,
      by: { userId: actor.userId },
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

  /** El saldo, si vale en este local y aún no tiene ficha. */
  private async walletWithoutFicha(venueId: string, walletId: string) {
    const [wallet, venue] = await Promise.all([
      this.prisma.acrossVenues((tx) =>
        tx.clientWallet.findUnique({
          where: { id: walletId },
          select: {
            id: true,
            tenantId: true,
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
    const issued = await this.prisma.acrossVenues((tx) =>
      tx.walletCard.findFirst({
        where: { walletId, status: { in: ISSUED_CARD_STATUSES } },
        select: { number: true, printedNumber: true },
      }),
    );
    if (issued) {
      throw new ConflictException(
        `Este saldo ya tiene ficha (nº ${issued.printedNumber ?? issued.number}). Si la ha perdido, el encargado le da otra.`,
      );
    }
    return wallet;
  }

  /** Cómo prueba el cliente que el saldo es suyo: su QR o su PIN (el encargado, sin prueba). */
  private async proofOf(actor: FichaActor, walletId: string, input: GiveFichaDto): Promise<GiveFichaVia> {
    if (input.proof !== undefined) {
      if (!fichaProofValid(this.config.get<string>('COOKIE_SECRET') ?? '', walletId, input.proof)) {
        throw new UnprocessableEntityException({
          message: 'Ese QR no es el de este saldo: que lo abra otra vez en su móvil',
          code: 'FICHA_PROOF_WRONG',
        });
      }
      return 'qr';
    }
    if (input.pin !== undefined) {
      // El de siempre: con el saldo bloqueado, cuenta los fallos (5 → bloqueado) y quién lo tecleó.
      await this.charges.checkPinForPayout(actor, walletId, input.pin);
      return 'pin';
    }
    if (actor.role === 'MANAGER' || actor.role === 'OWNER') return 'manager';
    throw new UnprocessableEntityException({
      message: 'Para darle la ficha, que te enseñe el QR de su saldo o que ponga su PIN',
      code: FICHA_PROOF_REQUIRED_CODE,
    });
  }
}
