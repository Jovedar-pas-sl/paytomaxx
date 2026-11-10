import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  AssignedTopUp,
  CreatedPaymentResponse,
  PendingTopUpStartDto,
  PendingTopUpView,
  SaldoRefDto,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { paymentMethodLabel, paymentMethodOf } from '../money-map/cobros-rows';
import { assertCanTopUp } from '../venues/charge-rights';
import { assertVenueAcceptsMethods } from '../venues/venue-methods';
import { WalletChargesService, codeHintOf } from './wallet-charges.service';
import { topUpTarget } from './wallet-topup-target';

/** Quien cobra o asigna: la persona del local (la chica, solo las suyas). */
export interface PendingTopUpActor {
  userId: string;
  role: string;
  tenantId: string;
}

const NOT_FOUND = 'No hay ninguna recarga pendiente de asignar con ese número en este local';
const NOT_PAID = 'Esta recarga aún no consta como pagada: espera a que el cliente termine de pagar';

/**
 * Recargas pendientes de asignar (plan B de «Recargar saldo»): el NFC del
 * cliente no se pudo leer antes de cobrar. Se cobra con la maquinaria de
 * siempre (PaymentsService.create, recarga con «saldo nuevo»): el dinero va a
 * un saldo propio, marcado como pendiente de asignar, y al acercar su NFC o
 * teclear su código se suma a su saldo (mergeInto: el mismo camino que «Sumar
 * a mi saldo», con los mismos candados). Nunca se pierde: si nadie la asigna,
 * sale en Incidencias y su dinero sigue en ese saldo (el cliente tiene su
 * enlace en la página de «Pagado»).
 *
 * PaymentsService con ModuleRef: PaymentsModule ya importa WalletsModule.
 */
@Injectable()
export class PendingTopUpService {
  private readonly logger = new Logger(PendingTopUpService.name);
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly charges: WalletChargesService;
  private readonly moduleRef: ModuleRef;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(ModuleRef) moduleRef: ModuleRef,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.charges = charges;
    this.moduleRef = moduleRef;
  }

  /**
   * Cobrar primero: una recarga con tarjeta (el QR en el móvil del cliente) a
   * un saldo provisional, marcado como pendiente de asignar. La misma clave
   * repetida devuelve el mismo cobro (y lo vuelve a marcar si hiciera falta).
   */
  async start(actor: PendingTopUpActor, input: PendingTopUpStartDto): Promise<CreatedPaymentResponse> {
    // Cargar saldo, solo en recepción (el puesto), el encargado o el dueño.
    await this.assertCanTopUp(actor);
    const terminal = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { externalId: 'asc' },
        select: { externalId: true },
      }),
    );
    if (!terminal) throw new ConflictException('No hay terminales configurados en el local');
    const created = await this.payments().create(
      actor.tenantId,
      input.idempotencyKey,
      {
        amountCents: input.amountCents,
        currency: 'EUR',
        terminalExternalId: terminal.externalId,
        wallet: { create: true },
      },
      { userId: actor.userId, role: actor.role },
    );
    const walletId = created.walletId;
    if (!walletId) throw new ConflictException('No se ha podido preparar la recarga: vuelve a intentarlo');
    await this.prisma.asSystem((tx) =>
      tx.clientWallet.updateMany({
        where: { id: walletId, tenantId: actor.tenantId, pendingAssignAt: null, mergedIntoId: null },
        data: { pendingAssignAt: new Date(), pendingAssignById: actor.userId },
      }),
    );
    this.logger.log(`Recarga pendiente de asignar: payment=${created.id} wallet=${walletId} (${actor.userId})`);
    return created;
  }

  /** Las cobradas que esperan su saldo (la chica, solo las suyas), de la más nueva a la más vieja. */
  async list(actor: PendingTopUpActor): Promise<PendingTopUpView[]> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findMany({
        where: {
          tenantId: actor.tenantId,
          pendingAssignAt: { not: null },
          mergedIntoId: null,
          status: 'ACTIVE',
          balanceCents: { gt: 0 },
          ...(onlyOwn(actor) ? { pendingAssignById: actor.userId } : {}),
        },
        orderBy: { pendingAssignAt: 'desc' },
        take: 50,
        select: { id: true, balanceCents: true, pendingAssignAt: true, pendingAssignById: true },
      }),
    );
    const paidWith = await this.paidWith(rows.map((r) => r.id));
    const ids = [...new Set(rows.map((r) => r.pendingAssignById).filter((id): id is string => id !== null))];
    const users =
      ids.length === 0
        ? []
        : await this.prisma.asSystem((tx) =>
            tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, email: true } }),
          );
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.pendingAssignById);
      return {
        walletId: r.id,
        amountCents: r.balanceCents,
        since: (r.pendingAssignAt ?? new Date()).toISOString(),
        byName: u ? (u.displayName?.trim() || u.email.split('@')[0] || null) : null,
        paidWith: paidWith.get(r.id) ?? null,
      };
    });
  }

  /**
   * Cómo pagó cada una (A8): «Tarjeta Visa ••4242», «Apple Pay / Google Pay»
   * o «Datáfono», como en Cobros del panel. Así se reconoce al cliente en la
   * lista sin enseñar nada suyo más (ni el saldo ni su enlace).
   */
  private async paidWith(walletIds: string[]): Promise<Map<string, string>> {
    if (walletIds.length === 0) return new Map();
    const payments = await this.prisma.asSystem((tx) =>
      tx.payment.findMany({
        where: { walletId: { in: walletIds }, status: 'AUTHORIZED' },
        orderBy: { createdAt: 'desc' },
        select: {
          walletId: true,
          captureMethod: true,
          posOperationNumber: true,
          authorizedAt: true,
          cardBrand: true,
          cardLast4: true,
          attempts: { select: { status: true, payMethod: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    const out = new Map<string, string>();
    for (const p of payments) {
      if (!p.walletId || out.has(p.walletId)) continue;
      const method = paymentMethodOf(p);
      if (method) out.set(p.walletId, paymentMethodLabel(method, p));
    }
    return out;
  }

  /**
   * Asignarla: su NFC o su código dicen de qué saldo es y la recarga se suma a
   * él. Solo cuando ya está pagada; una vez (la segunda vez ya no está pendiente).
   */
  async assign(actor: PendingTopUpActor, walletId: string, ref: SaldoRefDto): Promise<AssignedTopUp> {
    await this.assertCanTopUp(actor);
    if ('card' in ref) await this.prisma.asSystem((tx) => assertVenueAcceptsMethods(tx, actor.tenantId, ['nfc']));
    const pending = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findFirst({
        where: { id: walletId, tenantId: actor.tenantId },
        select: { id: true, status: true, balanceCents: true, mergedIntoId: true, pendingAssignAt: true, pendingAssignById: true },
      }),
    );
    if (!pending?.pendingAssignAt || (onlyOwn(actor) && pending.pendingAssignById !== actor.userId)) {
      throw new NotFoundException(NOT_FOUND);
    }
    if (pending.mergedIntoId) throw new ConflictException('Esta recarga ya está asignada a su saldo');
    if (pending.status !== 'ACTIVE' || pending.balanceCents <= 0) throw new ConflictException(NOT_PAID);
    const target = await topUpTarget(this.prisma, actor.tenantId, 'card' in ref ? { card: ref.card, uid: ref.uid ?? null } : ref);
    if (target.id === walletId) throw new ConflictException('Esa es la propia recarga: acerca el NFC del cliente o teclea su código');
    const targetPending = await this.prisma.acrossVenues((tx) =>
      tx.clientWallet.findUnique({ where: { id: target.id }, select: { pendingAssignAt: true } }),
    );
    if (targetPending?.pendingAssignAt) {
      throw new ConflictException('Ese saldo también está pendiente de asignar: usa el NFC o el código del cliente');
    }
    const { balanceCents } = await this.charges.mergeInto(walletId, target.id);
    await this.audit.log({
      action: 'wallet.topup_assigned',
      tenantId: actor.tenantId,
      actorId: actor.userId,
      targetType: 'ClientWallet',
      targetId: target.id,
      payload: { from: walletId, amountCents: pending.balanceCents, via: 'card' in ref ? 'nfc' : 'code' },
    });
    this.logger.log(`Recarga pendiente ${walletId} asignada al saldo ${target.id} (${actor.userId})`);
    return { walletId: target.id, codeHint: codeHintOf(target.shortCode), amountCents: pending.balanceCents, balanceCents };
  }

  /** 403 «Las recargas se hacen en recepción» si su puesto no carga saldos. */
  private async assertCanTopUp(actor: PendingTopUpActor): Promise<void> {
    await this.prisma.asSystem((tx) => assertCanTopUp(tx, actor.tenantId, { userId: actor.userId, role: actor.role }));
  }

  private payments(): PaymentsService {
    return this.moduleRef.get(PaymentsService, { strict: false });
  }
}

/** La chica ve y asigna solo las suyas; el personal de la recepción y el encargado, todas las del local. */
function onlyOwn(actor: { role: string }): boolean {
  return actor.role === 'OPERATOR';
}
