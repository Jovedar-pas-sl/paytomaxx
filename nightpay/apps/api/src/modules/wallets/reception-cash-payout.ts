import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  PAYOUT_PASSKEY_REQUIRED_CODE,
  PAYOUT_PASSKEY_REQUIRED_MESSAGE,
  nightSettingsOf,
  normalizeWalletCardUid,
  staffPermissionsOf,
  type ReceptionPayoutPlan,
  type ReceptionPayoutReason,
  type Role,
} from '@nightpay/contracts';
import type { PrismaService, TransactionalClient } from '../../common/prisma/prisma.service';
import type { AuditInput } from '../audit/audit.service';
import type { TotpService } from '../auth/totp.service';
import { assertCanPayOutCash, chargeRightsFor } from '../venues/charge-rights';
import { assertMethodsEnabled } from '../venues/venue-methods';
import { cashPayoutCapCents, cashPayoutRefusal, walletCash } from './wallet-cash-limits';
import { isIssuedCard, lockCard, returnWalletCards, type LockedCard } from './wallet-card-ops';
import { sameWalletGroup } from './wallet-rules';
import { assertTwoFactorCode, cashApprovalThreshold, eur } from './wallet-two-factor';
import {
  RECEPTION_PAYOUT_CAP_ACTION,
  capReachedFirstTime,
  lockReceptionNight,
  payoutAuthorisedBy,
  payoutNeeds,
  payoutReasonText,
  receptionNightPaidCents,
} from './reception-payout-rules';
import type { PayoutPasskeyRequest } from './reception-payout-passkey';

/**
 * Salida de recepción (maqueta 4.5): devolver el saldo en efectivo con el NFC
 * original del cliente (su token y su número de serie) y:
 *  - su PIN (con su contador de fallos), o
 *  - si el saldo tiene Face ID, su confirmación en SU móvil (el QR de la
 *    salida, ReceptionPayoutPasskeys): el PIN solo no basta.
 * Más de 100 € (más de 100,00 €) o pasado el tope de la noche de quien
 * devuelve: el encargado con su 2FA (si devuelve él) o pendiente para él (si
 * devuelve recepción). Lo que no sale en efectivo queda pedido para el dueño
 * «A la tarjeta». Todo, con su registro, en la transacción del dinero.
 */

export type Actor = { userId: string; role: Role; tenantId: string };
export interface ReceptionCashInput {
  card: string;
  uid: string;
  /** Sin Face ID confirmado, el PIN del cliente. */
  pin?: string;
  expectedAmountCents: number;
  requestKey: string;
  totpCode?: string;
}
/** El móvil de recepción desde el que se hace (queda en el registro). */
export interface ReceptionDevice {
  ip?: string;
  userAgent?: string;
}
export type ReceptionCashResult =
  | { kind: 'done'; refundedCents: number; remainingCents: number }
  | { kind: 'manager'; amountCents: number; message: string; reasons?: ReceptionPayoutReason[] };

export interface ReceptionPayoutDeps {
  prisma: PrismaService;
  audit: { logInTx(tx: Pick<TransactionalClient, 'auditEvent'>, input: AuditInput): Promise<void> };
  totp: Pick<TotpService, 'assertForUser' | 'isEnabled'>;
  checkPin(walletId: string, pin: string): Promise<void>;
  hasPasskey(walletId: string): Promise<boolean>;
  passkeyRequest(tenantId: string, requestKey: string): Promise<PayoutPasskeyRequest | null>;
}

interface LockedWallet {
  id: string; tenantId: string; walletGroup: string | null; status: string; balanceCents: number;
  pinHash: string | null; blockedAt: Date | null; pinLockedAt: Date | null; closeRequestedAt: Date | null;
}
export interface PayoutVenue {
  id: string; name: string; walletGroup: string | null; refundApprovalThresholdCents: number | null;
  nightSettings: unknown; paymentMethods: unknown;
}
/** Cómo lo autorizó el cliente: su Face ID para esta salida, o su PIN. */
interface Auth { passkey: boolean; hasPasskey: boolean }

const KEY_USED = 'Esta petición de salida ya se usó para otra devolución';

/** Un recibo solo se repite a quien lo creó, con el mismo saldo e importe. */
export async function payoutReceipt(tx: TransactionalClient, actor: Actor, walletId: string, input: Pick<ReceptionCashInput, 'requestKey' | 'expectedAmountCents'>): Promise<ReceptionCashResult | null> {
  const row = await tx.walletPayout.findUnique({ where: { tenantId_requestKey: { tenantId: actor.tenantId, requestKey: input.requestKey } } });
  if (!row) return null;
  if (row.walletId !== walletId || row.paidByUserId !== actor.userId || row.amountCents !== input.expectedAmountCents || row.method !== 'CASH' || row.status !== 'DONE') {
    throw new ConflictException(KEY_USED);
  }
  return { kind: 'done', refundedCents: row.amountCents, remainingCents: row.remainingBalanceCents ?? 0 };
}

function assertOriginalCard(card: LockedCard | null, walletId: string, input: Pick<ReceptionCashInput, 'uid'>): void {
  const uid = normalizeWalletCardUid(input.uid);
  if (!card || !isIssuedCard(card) || card.walletId !== walletId || !uid || !card.uid || normalizeWalletCardUid(card.uid) !== uid) {
    throw new NotFoundException('Este NFC no autoriza la salida de ese saldo: vuelve a acercar el original');
  }
}

export function assertPayoutInput(input: Pick<ReceptionCashInput, 'expectedAmountCents' | 'requestKey'>): void {
  if (!Number.isInteger(input.expectedAmountCents) || input.expectedAmountCents <= 0 || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestKey)) {
    throw new BadRequestException('Importe o referencia de salida incorrectos');
  }
}

/** El local y el permiso propio de devolver efectivo (no el de las recargas). */
export async function payoutVenue(prisma: PrismaService, actor: Actor): Promise<PayoutVenue> {
  return prisma.asSystem(async (tx) => {
    const v = await tx.venue.findUnique({ where: { id: actor.tenantId } });
    if (!v) throw new NotFoundException('Local no encontrado');
    const rights = await chargeRightsFor(tx, actor.tenantId, actor);
    assertCanPayOutCash(rights, actor, staffPermissionsOf(v.staffPermissions));
    return v;
  });
}

/** El NFC original de ese saldo y el saldo, de este grupo de locales (sin bloquear). */
export async function payoutCardAndWallet(prisma: PrismaService, venue: PayoutVenue, walletId: string, input: Pick<ReceptionCashInput, 'card' | 'uid'>) {
  return prisma.acrossVenues(async (tx) => {
    const card = await tx.walletCard.findUnique({ where: { token: input.card } });
    assertOriginalCard(card, walletId, input);
    const w = await tx.clientWallet.findUnique({ where: { id: walletId } });
    if (!w || !sameWalletGroup(w, venue)) throw new NotFoundException('Saldo no encontrado');
    return { wallet: w, cardId: card?.id ?? null, cash: await walletCash(tx, walletId) };
  });
}

/** La confirmación con Face ID de esta salida (de esta persona, este saldo y este importe). */
async function passkeyConfirmed(deps: ReceptionPayoutDeps, actor: Actor, walletId: string, input: ReceptionCashInput): Promise<boolean> {
  const request = await deps.passkeyRequest(actor.tenantId, input.requestKey);
  return !!request && request.confirmed && request.walletId === walletId && request.userId === actor.userId
    && request.tenantId === actor.tenantId && request.amountCents === input.expectedAmountCents;
}

function passkeyRequired(): ConflictException {
  return new ConflictException({ message: PAYOUT_PASSKEY_REQUIRED_MESSAGE, code: PAYOUT_PASSKEY_REQUIRED_CODE });
}

/**
 * Qué hace falta para devolver `amountCents` ahora (sin bloquear: el plan y
 * la comprobación de antes del PIN). Con el saldo bloqueado se vuelve a mirar.
 */
async function needsNow(prisma: PrismaService, venue: PayoutVenue, actor: Actor, amountCents: number, passkey: { has: boolean; confirmed: boolean }) {
  const nightPaidCents = await prisma.asSystem((tx) => receptionNightPaidCents(tx, actor.tenantId, actor.userId));
  const nightCapCents = nightSettingsOf(venue.nightSettings).receptionPayoutNightCapCents;
  const limitCents = cashApprovalThreshold(venue.refundApprovalThresholdCents);
  const plan = payoutNeeds({ role: actor.role, amountCents, limitCents, nightPaidCents, nightCapCents, hasPasskey: passkey.has, passkeyConfirmed: passkey.confirmed });
  return { ...plan, nightPaidCents, nightCapCents, limitCents };
}

/**
 * Antes de que el cliente ponga su PIN: lo que hace falta para esta salida
 * (el encargado, su Face ID…). Solo lee. El importe es el de ahora.
 */
export async function receptionPayoutPlan(deps: Pick<ReceptionPayoutDeps, 'prisma' | 'hasPasskey'>, actor: Actor, walletId: string): Promise<ReceptionPayoutPlan> {
  const venue = await payoutVenue(deps.prisma, actor);
  const amountCents = await deps.prisma.acrossVenues(async (tx) => {
    const w = await tx.clientWallet.findUnique({ where: { id: walletId } });
    if (!w || !sameWalletGroup(w, venue)) throw new NotFoundException('Saldo no encontrado');
    return w.status === 'ACTIVE' ? cashPayoutCapCents(w.balanceCents, await walletCash(tx, walletId)) : 0;
  });
  const has = await deps.hasPasskey(walletId);
  // Con Face ID, el plan cuenta con que lo confirme en su móvil (el QR va primero).
  const n = await needsNow(deps.prisma, venue, actor, amountCents, { has, confirmed: has });
  return {
    amountCents,
    needs: n.needs === 'manager_2fa' || n.needs === 'manager_pending' ? n.needs : 'none',
    reasons: n.reasons,
    passkey: has && actor.role !== 'OWNER',
    nightPaidCents: n.nightPaidCents,
    nightCapCents: n.nightCapCents,
  };
}

/** Salida de recepción: autorización del cliente, dinero bajo bloqueo y su registro dentro. */
export async function receptionCashPayout(
  deps: ReceptionPayoutDeps,
  actor: Actor,
  walletId: string,
  input: ReceptionCashInput,
  device: ReceptionDevice = {},
): Promise<ReceptionCashResult> {
  assertPayoutInput(input);
  const venue = await payoutVenue(deps.prisma, actor);
  // Un reintento debe funcionar también después de devolver el NFC al stock.
  const previous = await deps.prisma.acrossVenues((tx) => payoutReceipt(tx, actor, walletId, input));
  if (previous) return previous;
  assertMethodsEnabled(venue, ['wallet', 'nfc']);
  const before = await precheck(deps, venue, actor, walletId, input);
  if (before.receipt) return before.receipt;
  if (!before.auth.passkey) {
    if (!input.pin || !/^\d{4}$/.test(input.pin)) throw new BadRequestException('Falta el PIN del cliente');
    await deps.checkPin(walletId, input.pin);
  }
  const s: Settle = { actor, venue, walletId, input, device, auth: before.auth, pinHash: before.pinHash };
  return deps.prisma.acrossVenues((tx) => settle(tx, deps, s)).catch(async (error: unknown): Promise<ReceptionCashResult> => {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
    // La transacción ya se ha revertido (también su registro): nunca
    // consultar dentro de una transacción abortada por el requestKey.
    const committed = await deps.prisma.acrossVenues((tx) => payoutReceipt(tx, actor, walletId, input));
    if (committed) return committed;
    throw new ConflictException(KEY_USED);
  });
}

/**
 * Antes del PIN: el NFC original, el saldo, su Face ID y lo que hace falta.
 * Lo que va a pedir al encargado o al cliente en su móvil se dice ya, sin
 * gastar el PIN (el cliente lo teclea una sola vez).
 */
async function precheck(deps: ReceptionPayoutDeps, venue: PayoutVenue, actor: Actor, walletId: string, input: ReceptionCashInput) {
  let pinHash: string | null;
  try {
    pinHash = (await payoutCardAndWallet(deps.prisma, venue, walletId, input)).wallet.pinHash;
  } catch (error) {
    // Otra salida puede confirmar y devolver el NFC después del precheck.
    // En READ COMMITTED esta nueva consulta ya ve su recibo confirmado.
    if (!(error instanceof NotFoundException)) throw error;
    const committed = await deps.prisma.acrossVenues((tx) => payoutReceipt(tx, actor, walletId, input));
    if (committed) return { receipt: committed, auth: { passkey: false, hasPasskey: false }, pinHash: null };
    throw error;
  }
  const hasPasskey = await deps.hasPasskey(walletId);
  const confirmed = hasPasskey && (await passkeyConfirmed(deps, actor, walletId, input));
  const n = await needsNow(deps.prisma, venue, actor, input.expectedAmountCents, { has: hasPasskey, confirmed });
  if (n.needs === 'passkey_required') throw passkeyRequired();
  if (n.needs === 'manager_2fa' && !input.totpCode) {
    await assertTwoFactorCode(deps.totp, actor.userId, undefined, twoFactorWhy(input.expectedAmountCents, n.reasons, n.limitCents, n.nightCapCents));
  }
  const auth: Auth = { passkey: confirmed, hasPasskey };
  return { receipt: null, auth, pinHash };
}

/** «Devolver 120,00 € en efectivo: más de 100,00 €,» (le sigue «pon el código…»). */
function twoFactorWhy(amountCents: number, reasons: readonly ReceptionPayoutReason[], limitCents: number, capCents: number): string {
  return `Devolver ${eur(amountCents)} en efectivo: ${payoutReasonText(reasons, limitCents, capCents)},`;
}

interface Settle {
  actor: Actor;
  venue: PayoutVenue;
  walletId: string;
  input: ReceptionCashInput;
  device: ReceptionDevice;
  auth: Auth;
  pinHash: string | null;
}
interface Night { paid: number; cap: number; limit: number }

/** Con el saldo, el NFC y la noche de esta persona bloqueados (en este orden: como attachCard y payout). */
async function settle(tx: TransactionalClient, deps: ReceptionPayoutDeps, s: Settle): Promise<ReceptionCashResult> {
  const { actor, walletId, input } = s;
  const rows = await tx.$queryRaw<LockedWallet[]>`
    SELECT id, "tenantId", "walletGroup", status, "balanceCents", "pinHash", "blockedAt", "pinLockedAt", "closeRequestedAt"
      FROM client_wallets WHERE id = ${walletId}::uuid FOR UPDATE
  `;
  const card = await lockCard(tx, input.card);
  const repeated = await payoutReceipt(tx, actor, walletId, input);
  if (repeated) return repeated;
  const w = rows[0];
  if (!w || !sameWalletGroup(w, s.venue)) throw new NotFoundException('Saldo no encontrado');
  assertOriginalCard(card, walletId, input);
  const amount = await lockedAmount(tx, s, w);
  await lockReceptionNight(tx, actor.tenantId, actor.userId);
  const night: Night = {
    paid: await receptionNightPaidCents(tx, actor.tenantId, actor.userId),
    cap: nightSettingsOf(s.venue.nightSettings).receptionPayoutNightCapCents,
    limit: cashApprovalThreshold(s.venue.refundApprovalThresholdCents),
  };
  const n = payoutNeeds({ role: actor.role, amountCents: amount, limitCents: night.limit, nightPaidCents: night.paid,
    nightCapCents: night.cap, hasPasskey: s.auth.hasPasskey, passkeyConfirmed: s.auth.passkey });
  if (n.needs === 'passkey_required') throw passkeyRequired();
  if (n.reasons.includes('night_cap')) await capIncident(tx, deps, s, amount, night);
  if (n.needs === 'manager_pending') return pending(tx, deps, s, amount, n.reasons, night);
  const twoFactor = n.needs === 'manager_2fa';
  if (twoFactor) await assertTwoFactorCode(deps.totp, actor.userId, input.totpCode, twoFactorWhy(amount, n.reasons, night.limit, night.cap));
  return pay(tx, deps, s, w, { amount, twoFactor, cardId: card?.id ?? null });
}

/** Lo que sale ahora (con el saldo bloqueado): el que confirmó el cliente, o nada. */
async function lockedAmount(tx: TransactionalClient, s: Settle, w: LockedWallet): Promise<number> {
  if (!s.auth.passkey && w.pinHash !== s.pinHash) throw new ConflictException('El PIN ha cambiado: vuelve a confirmar la salida');
  if (!s.auth.passkey && w.pinLockedAt) throw new ConflictException('PIN bloqueado: avisa al encargado');
  if (w.blockedAt) throw new ForbiddenException('Saldo bloqueado: la salida la revisa el encargado');
  if (w.status !== 'ACTIVE' || w.balanceCents <= 0) throw new ConflictException('Este saldo no tiene nada que devolver');
  if (await tx.walletPayout.findFirst({ where: { walletId: s.walletId, status: 'PENDING' } })) {
    throw new ConflictException('Hay una devolución a la tarjeta pendiente: que la termine el dueño');
  }
  const cash = await walletCash(tx, s.walletId);
  const amount = cashPayoutCapCents(w.balanceCents, cash);
  if (amount <= 0) throw new ConflictException(cashPayoutRefusal(w.balanceCents, cash));
  if (amount !== s.input.expectedAmountCents) throw new ConflictException('El importe ha cambiado: vuelve a acercar el NFC y confirma lo que se devuelve');
  return amount;
}

/** Recepción pasa su tope: la primera vez de la noche, al registro (→ Incidencias y Telegram). */
async function capIncident(tx: TransactionalClient, deps: ReceptionPayoutDeps, s: Settle, amount: number, night: Night): Promise<void> {
  if (!(await capReachedFirstTime(tx, s.actor.tenantId, s.actor.userId))) return;
  await deps.audit.logInTx(tx, {
    action: RECEPTION_PAYOUT_CAP_ACTION, tenantId: s.actor.tenantId, actorId: s.actor.userId, targetType: 'User', targetId: s.actor.userId,
    ip: s.device.ip, userAgent: s.device.userAgent,
    payload: { amountCents: amount, nightPaidCents: night.paid, nightCapCents: night.cap, walletId: s.walletId, requestKey: s.input.requestKey, role: s.actor.role },
  });
}

/** Recepción no puede sola: pendiente para el encargado (lo confirma en el panel con su 2FA). No sale dinero. */
async function pending(tx: TransactionalClient, deps: ReceptionPayoutDeps, s: Settle, amount: number, reasons: ReceptionPayoutReason[], night: Night): Promise<ReceptionCashResult> {
  const changed = await tx.clientWallet.updateMany({ where: { id: s.walletId, closeRequestedAt: null }, data: { closeRequestedAt: new Date() } });
  await deps.audit.logInTx(tx, {
    action: 'wallet.close_requested', tenantId: s.actor.tenantId, actorId: s.actor.userId, targetType: 'ClientWallet', targetId: s.walletId,
    ip: s.device.ip, userAgent: s.device.userAgent,
    payload: { amountCents: amount, via: 'reception', managerRequired: true, reasons, requestKey: s.input.requestKey,
      authorisedBy: payoutAuthorisedBy(s.auth.passkey, false), alreadyRequested: changed.count === 0 },
  });
  const why = payoutReasonText(reasons, night.limit, night.cap);
  return { kind: 'manager', amountCents: amount, reasons,
    message: `Pendiente del encargado (${why}): aún no se ha devuelto dinero. Lo confirma en el panel con su 2FA.` };
}

/**
 * Sale el efectivo: el saldo baja, la salida queda apuntada con su
 * requestKey y, si queda saldo (entró con tarjeta), pedido para el dueño «A
 * la tarjeta» (Incidencias, el cierre de la noche y Clientes → Saldos).
 */
async function pay(tx: TransactionalClient, deps: ReceptionPayoutDeps, s: Settle, w: LockedWallet, n: { amount: number; twoFactor: boolean; cardId: string | null }): Promise<ReceptionCashResult> {
  const { actor, walletId } = s;
  const remaining = w.balanceCents - n.amount;
  const askCard = remaining > 0 && w.closeRequestedAt === null;
  await tx.clientWallet.update({
    where: { id: walletId },
    data: { balanceCents: remaining, ...(remaining === 0 ? { status: 'REFUNDED' } : {}), ...(askCard ? { closeRequestedAt: new Date() } : {}) },
  });
  if (remaining === 0) await returnWalletCards(tx, walletId, actor.tenantId, { userId: actor.userId });
  const payout = await tx.walletPayout.create({
    data: { tenantId: actor.tenantId, walletId, amountCents: n.amount, method: 'CASH', status: 'DONE', paidByUserId: actor.userId,
      requestKey: s.input.requestKey, remainingBalanceCents: remaining },
    select: { id: true },
  });
  const common = { tenantId: actor.tenantId, actorId: actor.userId, targetType: 'ClientWallet', targetId: walletId, ip: s.device.ip, userAgent: s.device.userAgent };
  await deps.audit.logInTx(tx, {
    ...common, action: 'wallet.payout',
    payload: { method: 'CASH', via: 'reception', refundedCents: n.amount, remainingCents: remaining, payoutId: payout.id, requestKey: s.input.requestKey,
      cardId: n.cardId, authorisedBy: payoutAuthorisedBy(s.auth.passkey, n.twoFactor), twoFactor: n.twoFactor, role: actor.role },
  });
  if (askCard) {
    await deps.audit.logInTx(tx, {
      ...common, action: 'wallet.close_requested',
      payload: { via: 'reception', reason: 'card_rest', remainingCents: remaining, payoutId: payout.id, requestKey: s.input.requestKey },
    });
  }
  return { kind: 'done', refundedCents: n.amount, remainingCents: remaining };
}
