import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { normalizeWalletCardUid, staffCan, staffPermissionsOf, type Role } from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { TotpService } from '../auth/totp.service';
import { assertCanHandleCash, chargeRightsFor, topUpForbidden } from '../venues/charge-rights';
import { assertMethodsEnabled } from '../venues/venue-methods';
import { permissionDenied } from '../venues/staff-permission.guard';
import { cashPayoutCapCents, cashPayoutRefusal, walletCash } from './wallet-cash-limits';
import { isIssuedCard, lockCard, returnWalletCards, type LockedCard } from './wallet-card-ops';
import { sameWalletGroup } from './wallet-rules';
import { assertManagerTwoFactor, cashApprovalThreshold } from './wallet-two-factor';

type Actor = { userId: string; role: Role; tenantId: string };
export interface ReceptionCashInput {
  card: string;
  uid: string;
  pin: string;
  expectedAmountCents: number;
  requestKey: string;
  totpCode?: string;
}
export type ReceptionCashResult =
  | { kind: 'done'; refundedCents: number; remainingCents: number }
  | { kind: 'manager'; amountCents: number; message: string };
interface Dependencies {
  prisma: PrismaService;
  audit: AuditService;
  totp: TotpService;
  checkPin(walletId: string, pin: string): Promise<void>;
}
interface LockedWallet {
  id: string; tenantId: string; walletGroup: string | null; status: string; balanceCents: number;
  pinHash: string | null; blockedAt: Date | null; pinLockedAt: Date | null;
}

/** Un recibo solo se repite a quien lo creó, con el mismo saldo e importe. */
async function receipt(tx: TransactionalClient, actor: Actor, walletId: string, input: ReceptionCashInput): Promise<ReceptionCashResult | null> {
  const row = await tx.walletPayout.findUnique({ where: { tenantId_requestKey: { tenantId: actor.tenantId, requestKey: input.requestKey } } });
  if (!row) return null;
  if (row.walletId !== walletId || row.paidByUserId !== actor.userId || row.amountCents !== input.expectedAmountCents || row.method !== 'CASH' || row.status !== 'DONE') {
    throw new ConflictException('Esta petición de salida ya se usó para otra devolución');
  }
  return { kind: 'done', refundedCents: row.amountCents, remainingCents: row.remainingBalanceCents ?? 0 };
}

/** No acepta el código del saldo: hace falta el NFC leído y su UID original. */
async function originalCard(tx: TransactionalClient, walletId: string, input: ReceptionCashInput): Promise<void> {
  const card = await tx.walletCard.findUnique({ where: { token: input.card } });
  assertOriginalCard(card, walletId, input);
}

function assertOriginalCard(card: LockedCard | null, walletId: string, input: ReceptionCashInput): void {
  const uid = normalizeWalletCardUid(input.uid);
  if (!card || !isIssuedCard(card) || card.walletId !== walletId || !uid || !card.uid || normalizeWalletCardUid(card.uid) !== uid) {
    throw new NotFoundException('Este NFC no autoriza la salida de ese saldo: vuelve a acercar el original');
  }
}

/** Salida de recepción: PIN verificado con su contador y dinero bajo bloqueo. */
export async function receptionCashPayout(deps: Dependencies, actor: Actor, walletId: string, input: ReceptionCashInput): Promise<ReceptionCashResult> {
  if (!Number.isInteger(input.expectedAmountCents) || input.expectedAmountCents <= 0 || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestKey)) {
    throw new BadRequestException('Importe o referencia de salida incorrectos');
  }
  const venue = await deps.prisma.asSystem(async (tx) => {
    const v = await tx.venue.findUnique({ where: { id: actor.tenantId } });
    if (!v) throw new NotFoundException('Local no encontrado');
    if (!['WAITER', 'MANAGER', 'OWNER'].includes(actor.role)) throw topUpForbidden();
    const rights = await chargeRightsFor(tx, actor.tenantId, actor);
    if (!rights.topUps) throw topUpForbidden();
    const permissions = staffPermissionsOf(v.staffPermissions);
    if (actor.role === 'MANAGER') {
      if (!staffCan(permissions, actor, 'cash')) throw permissionDenied('cash');
    } else {
      assertCanHandleCash(rights, actor, permissions);
    }
    return v;
  });
  // Un reintento debe funcionar también después de devolver el NFC al stock.
  const previous = await deps.prisma.acrossVenues((tx) => receipt(tx, actor, walletId, input));
  if (previous) return previous;
  assertMethodsEnabled(venue, ['wallet', 'nfc']);
  const before = await deps.prisma.acrossVenues(async (tx) => {
    const raced = await receipt(tx, actor, walletId, input);
    if (raced) return { receipt: raced, wallet: null };
    try {
      await originalCard(tx, walletId, input);
    } catch (error) {
      // Otra salida puede confirmar y devolver el NFC después del precheck.
      // En READ COMMITTED esta nueva consulta ya ve su recibo confirmado.
      if (!(error instanceof NotFoundException)) throw error;
      const committed = await receipt(tx, actor, walletId, input);
      if (committed) return { receipt: committed, wallet: null };
      throw error;
    }
    const w = await tx.clientWallet.findUnique({ where: { id: walletId } });
    if (!w || !sameWalletGroup(w, { id: actor.tenantId, walletGroup: venue.walletGroup })) throw new NotFoundException('Saldo no encontrado');
    return { receipt: null, wallet: w };
  });
  if (before.receipt) return before.receipt;
  await deps.checkPin(walletId, input.pin);
  let auditNeeded = false;
  const result = await deps.prisma.acrossVenues(async (tx): Promise<ReceptionCashResult> => {
    // Mismo orden que attachCard y payout: saldo y después NFC.
    const rows = await tx.$queryRaw<LockedWallet[]>`
      SELECT id, "tenantId", "walletGroup", status, "balanceCents", "pinHash", "blockedAt", "pinLockedAt"
        FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
    `;
    const card = await lockCard(tx, input.card);
    const repeated = await receipt(tx, actor, walletId, input);
    if (repeated) return repeated;
    const w = rows[0];
    if (!w || !sameWalletGroup(w, { id: actor.tenantId, walletGroup: venue.walletGroup })) throw new NotFoundException('Saldo no encontrado');
    assertOriginalCard(card, walletId, input);
    if (w.pinHash !== before.wallet?.pinHash) throw new ConflictException('El PIN ha cambiado: vuelve a confirmar la salida');
    if (w.pinLockedAt) throw new ConflictException('PIN bloqueado: avisa al encargado');
    if (w.blockedAt) throw new ForbiddenException('Saldo bloqueado: la salida la revisa el encargado');
    if (w.status !== 'ACTIVE' || w.balanceCents <= 0) throw new ConflictException('Este saldo no tiene nada que devolver');
    if (await tx.walletPayout.findFirst({ where: { walletId, status: 'PENDING' } })) throw new ConflictException('Hay una devolución a la tarjeta pendiente: que la termine el dueño');
    const cash = await walletCash(tx, walletId);
    const amount = cashPayoutCapCents(w.balanceCents, cash);
    if (amount <= 0) throw new ConflictException(cashPayoutRefusal(w.balanceCents, cash));
    if (amount !== input.expectedAmountCents) throw new ConflictException('El importe ha cambiado: vuelve a acercar el NFC y confirma lo que se devuelve');
    // Recepción puede entregar hasta 100 €, o el límite inferior del local.
    const limit = cashApprovalThreshold(venue.refundApprovalThresholdCents);
    if (actor.role === 'WAITER' && amount > limit) {
      const changed = await tx.clientWallet.updateMany({ where: { id: walletId, closeRequestedAt: null }, data: { closeRequestedAt: new Date() } });
      auditNeeded = changed.count > 0;
      return { kind: 'manager', amountCents: amount, message: 'Pendiente del encargado: aún no se ha devuelto dinero. Lo confirma en el panel con su 2FA.' };
    }
    await assertManagerTwoFactor(deps.totp, actor, amount, limit, input.totpCode, 'Devolver saldo en recepción');
    const remaining = w.balanceCents - amount;
    await tx.clientWallet.update({ where: { id: walletId }, data: { balanceCents: remaining, ...(remaining === 0 ? { status: 'REFUNDED' } : {}) } });
    if (remaining === 0) await returnWalletCards(tx, walletId, actor.tenantId, { userId: actor.userId });
    await tx.walletPayout.create({ data: { tenantId: actor.tenantId, walletId, amountCents: amount, method: 'CASH', status: 'DONE', paidByUserId: actor.userId, requestKey: input.requestKey, remainingBalanceCents: remaining } });
    auditNeeded = true;
    return { kind: 'done', refundedCents: amount, remainingCents: remaining };
  }).catch(async (error: unknown): Promise<ReceptionCashResult> => {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
    // La transacción ya se ha revertido: nunca consultar dentro de una
    // transacción abortada por la restricción única del requestKey.
    auditNeeded = false;
    const committed = await deps.prisma.acrossVenues((tx) => receipt(tx, actor, walletId, input));
    if (committed) return committed;
    throw new ConflictException('Esta petición de salida ya se usó para otra devolución');
  });
  if (auditNeeded) await deps.audit.log({ action: result.kind === 'done' ? 'wallet.payout' : 'wallet.close_requested', tenantId: actor.tenantId, actorId: actor.userId,
    targetType: 'ClientWallet', targetId: walletId, payload: result.kind === 'done' ? { method: 'CASH', refundedCents: result.refundedCents, remainingCents: result.remainingCents, via: 'reception_nfc_pin' } : { amountCents: result.amountCents, via: 'reception_nfc_pin', managerRequired: true } });
  return result;
}
