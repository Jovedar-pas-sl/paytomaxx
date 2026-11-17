import { ConflictException } from '@nestjs/common';
import type { TransactionalClient } from '../../common/prisma/prisma.service';
import { saldoCredits, serviceFeeSaldoCents, serviceFeeSpendCents } from '../wallets/wallet-fee-saldo';

/** Un gasto del saldo del grupo de una reserva. */
export interface GroupSpend {
  tenantId: string;
  walletId: string;
  amountCents: number;
  providedByUserId: string;
  /** Sección del Z: VENUE_ENTRY (el reservado al llegar, la señal perdida) o VENUE_BAR (barra). */
  category: 'VENUE_ENTRY' | 'VENUE_BAR';
  notes: string;
  idempotencyKey: string;
}

/**
 * Gasta del saldo del grupo dentro de la transacción de quien llama: el saldo
 * bloqueado (FOR UPDATE), sin pasar de lo que tiene, un consumo de siempre
 * (venta del local en el Z y en el mapa del dinero; authMethod 'staff': lo
 * hace el personal con el QR del grupo) y el saldo que queda (a 0, DEPLETED).
 * Como en wallet-charges: el % antiguo de OxioPay va solo sobre lo cargado sin
 * «Comisión del servicio». Devuelve el id del consumo.
 */
export async function spendFromGroupWallet(tx: TransactionalClient, s: GroupSpend): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ balanceCents: number; status: string; blockedAt: Date | null }>>`
    SELECT "balanceCents", status::text AS status, "blockedAt" FROM client_wallets WHERE id = ${s.walletId}::uuid FOR UPDATE
  `;
  const w = rows[0];
  if (!w || w.blockedAt || (w.status !== 'ACTIVE' && w.status !== 'DEPLETED')) {
    throw new ConflictException({ message: 'El saldo del reservado no está disponible', code: 'RESERVATION_WALLET' });
  }
  if (w.balanceCents < s.amountCents) {
    throw new ConflictException({ message: 'No queda tanto en el reservado', code: 'RESERVATION_BALANCE', balanceCents: w.balanceCents });
  }
  const venue = await tx.venue.findUnique({ where: { id: s.tenantId }, select: { platformCommissionBps: true } });
  const feeSaldoCents = serviceFeeSaldoCents({
    amountCents: s.amountCents,
    tipCents: 0,
    feeSpendCents: serviceFeeSpendCents(await saldoCredits(tx, s.walletId), w.balanceCents, s.amountCents),
  });
  const consumption = await tx.walletConsumption.create({
    data: {
      tenantId: s.tenantId,
      walletId: s.walletId,
      amountCents: s.amountCents,
      providedByUserId: s.providedByUserId,
      category: s.category,
      notes: s.notes,
      idempotencyKey: s.idempotencyKey,
      authMethod: 'staff',
      ...(feeSaldoCents > 0 ? { serviceFeeSaldoCents: feeSaldoCents } : {}),
      ...(venue ? { platformCommissionBps: venue.platformCommissionBps } : {}),
    },
    select: { id: true },
  });
  const left = w.balanceCents - s.amountCents;
  await tx.$executeRaw`
    UPDATE client_wallets
       SET "balanceCents" = ${left}::int,
           status = ${left === 0 ? 'DEPLETED' : 'ACTIVE'}::"WalletStatus",
           "updatedAt" = now()
     WHERE id = ${s.walletId}::uuid
  `;
  return consumption.id;
}

/** Quien firma lo que hace el sistema (el cliente que anula, «No vino» automático): el dueño del local. */
export async function venueOwnerId(tx: TransactionalClient, tenantId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users
     WHERE "tenantId" = ${tenantId}::uuid AND role IN ('OWNER', 'MANAGER') AND "deletedAt" IS NULL
     ORDER BY (role = 'OWNER') DESC, "createdAt" ASC LIMIT 1
  `;
  const id = rows[0]?.id;
  if (!id) throw new ConflictException({ message: 'El local no tiene dueño ni encargado', code: 'RESERVATION_NO_OWNER' });
  return id;
}

/**
 * La señal se pierde («No vino» o el cliente anula): pasa a venta como un
 * consumo del saldo del grupo; lo pagado de más queda de saldo. Devuelve lo
 * perdido y lo que queda.
 */
export async function loseDeposit(
  tx: TransactionalClient,
  r: { id: string; ref: string; tenantId: string; walletId: string | null; depositCents: number; paidCents: number },
  providedByUserId: string,
  what: 'noshow' | 'cancel',
): Promise<{ lostCents: number; leftCents: number }> {
  const lostCents = Math.min(r.depositCents, r.paidCents);
  if (lostCents > 0) {
    if (!r.walletId) throw new ConflictException({ message: 'Esta reserva aún no tiene saldo', code: 'RESERVATION_WALLET' });
    await spendFromGroupWallet(tx, {
      tenantId: r.tenantId,
      walletId: r.walletId,
      amountCents: lostCents,
      providedByUserId,
      category: 'VENUE_ENTRY',
      notes: what === 'noshow' ? `Señal no devuelta: reservado ${r.ref}` : `Señal no devuelta (anulada por el cliente): reservado ${r.ref}`,
      // Con la hora: «No vino» se puede deshacer y volver a poner.
      idempotencyKey: `resv-${what}:${r.id}:${Date.now()}`,
    });
  }
  return { lostCents, leftCents: r.paidCents - lostCents };
}
