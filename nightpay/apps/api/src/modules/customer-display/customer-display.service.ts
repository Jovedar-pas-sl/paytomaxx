import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  CUSTOMER_DISPLAY_CODE_LENGTH,
  CUSTOMER_DISPLAY_CODE_TTL_MS,
  nightSettingsOf,
  paymentMethodsOf,
  type CustomerDisplayCode,
  type CustomerDisplayCurrentDto,
  type CustomerDisplayFichaDto,
  type CustomerDisplayFichaResult,
  type CustomerDisplayPairResult,
  type CustomerDisplayPinDto,
  type CustomerDisplayStatus,
  type CustomerDisplayTipDto,
  type CustomerScreenView,
} from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { publicBaseUrls } from '../payments/pay-qr-url';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { chargeRightsFor } from '../venues/charge-rights';
import { WalletChargesService } from '../wallets/wallet-charges.service';
import { PinRequiredException } from '../wallets/wallet-nopin';
import { displayKey, screenViewOf, tipAllowed } from './customer-screen';
import { followedRooms, nightClosedSince, pairingExpiresAt, type DisplaySession } from './display-auth';
import { formatDisplayCode, newDisplayCode, newDisplayToken, normalizeDisplayCode, sha256 } from './display-code';

/** Quien usa la app del personal (de su sesión). */
export interface DisplayOwner {
  userId: string;
  tenantId: string;
}

export const BAD_CODE_MESSAGE = 'Código no válido o caducado. Pide otro en la app del personal.';
export const CHARGE_NOT_FOUND_MESSAGE = 'Cobro no encontrado';
/** La tablet actuó sobre un cobro que ya no es el que enseña (otro cobro, o el camarero salió). */
export const NOT_CURRENT_MESSAGE = 'Este cobro ya no está en la pantalla';
export const NOT_CURRENT_CODE = 'DISPLAY_NOT_CURRENT';
export const BAD_TIP_MESSAGE = 'Propina no válida';
/** Dos códigos iguales a la vez (casi imposible): se prueba otro. */
const CODE_ATTEMPTS = 3;

/** Lo que deja la pantalla sin unión ni cobro (desemparejar, emparejar otra). */
const NO_SHOW = { paymentId: null, chargeId: null, shownAt: null, clearedAt: null } as const;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * «Pantalla del cliente»: emparejar (código de 5 minutos → credencial hasta
 * el cierre de la noche, 12 h como mucho), desemparejar desde los dos lados,
 * el cobro que enseña (lo pone la app del personal; solo uno suyo), lo que ve
 * la tablet, la propina que elige el cliente y pagar ese cobro con su ficha. Todo con
 * asSystem: la tablet no tiene sesión y la tabla lleva FORCE RLS; el local y
 * la persona salen siempre de la sesión o de la fila, nunca del cuerpo.
 */
@Injectable()
export class CustomerDisplayService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly realtime: RealtimeGateway;
  private readonly charges: WalletChargesService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(RealtimeGateway) realtime: RealtimeGateway,
    @Inject(WalletChargesService) charges: WalletChargesService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.realtime = realtime;
    this.charges = charges;
  }

  // ─── App del personal ──────────────────────────────────────────────

  async status(owner: DisplayOwner, now = new Date()): Promise<CustomerDisplayStatus> {
    const row = await this.activeOf(owner, now);
    return { paired: row !== null, pairedUntil: row?.expiresAt?.toISOString() ?? null };
  }

  /** «Emparejar»: un código nuevo (el anterior deja de valer). La pantalla que ya hubiera sigue hasta que se use. */
  async createCode(owner: DisplayOwner, now = new Date()): Promise<CustomerDisplayCode> {
    const expiresAt = new Date(now.getTime() + CUSTOMER_DISPLAY_CODE_TTL_MS);
    for (let attempt = 1; ; attempt += 1) {
      const code = newDisplayCode();
      const data = { pairingCodeHash: sha256(code), pairingCodeExpiresAt: expiresAt };
      try {
        await this.prisma.asSystem((tx) =>
          tx.customerDisplay.upsert({
            where: { userId: owner.userId },
            create: { tenantId: owner.tenantId, userId: owner.userId, ...data },
            update: data,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err) && attempt < CODE_ATTEMPTS) continue;
        throw err;
      }
      await this.audit.log({
        action: 'customer_display.code_created',
        tenantId: owner.tenantId,
        actorId: owner.userId,
        targetType: 'CustomerDisplay',
        targetId: owner.userId,
        payload: { expiresAt: expiresAt.toISOString() },
      });
      return { code: formatDisplayCode(code), expiresAt: expiresAt.toISOString() };
    }
  }

  /** «Desemparejar» desde la app del personal. */
  async unpairByOwner(owner: DisplayOwner): Promise<{ ok: true }> {
    const row = await this.prisma.asSystem((tx) =>
      tx.customerDisplay.findUnique({ where: { userId: owner.userId }, select: { id: true, tenantId: true, tokenHash: true } }),
    );
    if (row && row.tenantId === owner.tenantId) await this.revoke(row.id, owner, owner.userId, 'staff');
    return { ok: true };
  }

  /**
   * El cobro que enseña la pantalla (Esperando o la recarga de recepción).
   * Solo un cobro que creó esta persona y de su local. Sin pantalla: no hace nada.
   */
  async show(owner: DisplayOwner, dto: CustomerDisplayCurrentDto, now = new Date()): Promise<CustomerDisplayStatus> {
    const row = await this.activeOf(owner, now);
    if (!row) return { paired: false, pairedUntil: null };
    const paymentId = dto.paymentId?.toLowerCase() ?? null;
    const chargeId = dto.chargeId?.toLowerCase() ?? null;
    await this.assertOwnCharge(owner, paymentId, chargeId);
    const status = { paired: true, pairedUntil: row.expiresAt?.toISOString() ?? null };
    // El mismo cobro (la pantalla de espera se vuelve a montar): nada que avisar.
    if (row.paymentId === paymentId && row.chargeId === chargeId && row.clearedAt === null) return status;
    // Cobro nuevo: sin propina elegida (la elige el cliente, nada marcado de antemano).
    await this.prisma.asSystem((tx) =>
      tx.customerDisplay.update({
        where: { id: row.id },
        data: { paymentId, chargeId, shownAt: now, clearedAt: null, tipCents: 0 },
      }),
    );
    const follow = followedRooms({ paymentId, chargeId });
    const unfollow = followedRooms(row).filter((room) => !follow.includes(room));
    this.realtime.showOnDisplay(row.id, follow, unfollow);
    return status;
  }

  /** Salió de ese cobro: la pantalla vuelve al reposo (tras su «Pagado» si se pagó). Solo si sigue siendo ese. */
  async clear(owner: DisplayOwner, dto: CustomerDisplayCurrentDto, now = new Date()): Promise<{ ok: true }> {
    const row = await this.activeOf(owner, now);
    if (!row) return { ok: true };
    const cleared = await this.prisma.asSystem((tx) =>
      tx.customerDisplay.updateMany({
        where: {
          id: row.id,
          paymentId: dto.paymentId?.toLowerCase() ?? null,
          chargeId: dto.chargeId?.toLowerCase() ?? null,
          clearedAt: null,
        },
        data: { clearedAt: now },
      }),
    );
    if (cleared.count > 0) this.realtime.showOnDisplay(row.id, [], []);
    return { ok: true };
  }

  // ─── La tablet ─────────────────────────────────────────────────────

  /** Canjea el código (una sola vez) por la credencial. Si la persona ya tenía otra pantalla, esa queda fuera. */
  async pair(rawCode: string, now = new Date()): Promise<CustomerDisplayPairResult> {
    const code = normalizeDisplayCode(rawCode);
    if (code.length !== CUSTOMER_DISPLAY_CODE_LENGTH) throw new NotFoundException(BAD_CODE_MESSAGE);
    const codeHash = sha256(code);
    const row = await this.prisma.asSystem((tx) =>
      tx.customerDisplay.findFirst({
        where: { pairingCodeHash: codeHash, pairingCodeExpiresAt: { gt: now } },
        select: {
          id: true,
          tenantId: true,
          userId: true,
          tokenHash: true,
          user: { select: { deletedAt: true } },
          venue: { select: { name: true } },
        },
      }),
    );
    if (!row || row.user.deletedAt) throw new NotFoundException(BAD_CODE_MESSAGE);
    const token = newDisplayToken();
    // Hasta el corte de la noche (08:00) y nunca más de 12 h; cerrarla antes también la corta.
    const expiresAt = pairingExpiresAt(now);
    // Canje condicionado: dos tablets con el mismo código, solo una gana.
    const redeemed = await this.prisma.asSystem((tx) =>
      tx.customerDisplay.updateMany({
        where: { id: row.id, pairingCodeHash: codeHash, pairingCodeExpiresAt: { gt: now } },
        data: {
          tokenHash: sha256(token),
          pairedAt: now,
          expiresAt,
          revokedAt: null,
          lastSeenAt: now,
          pairingCodeHash: null,
          pairingCodeExpiresAt: null,
          tipCents: 0,
          ...NO_SHOW,
        },
      }),
    );
    if (redeemed.count === 0) throw new NotFoundException(BAD_CODE_MESSAGE);
    // La pantalla de antes (otra credencial): sus conexiones, fuera.
    if (row.tokenHash) this.realtime.closeDisplay(row.id);
    await this.audit.log({
      action: 'customer_display.paired',
      tenantId: row.tenantId,
      targetType: 'CustomerDisplay',
      targetId: row.userId,
      payload: { expiresAt: expiresAt.toISOString(), replaced: Boolean(row.tokenHash) },
    });
    return { token, venueName: row.venue.name, pairedUntil: expiresAt.toISOString() };
  }

  /** «Desemparejar» desde la tablet (solo su credencial). */
  async unpairByDisplay(display: DisplaySession): Promise<{ ok: true }> {
    await this.revoke(display.id, display, null, 'display', display.tokenHash);
    return { ok: true };
  }

  /** Lo que enseña la tablet ahora. */
  async screen(display: DisplaySession, now = new Date()): Promise<CustomerScreenView> {
    const { venue, payment, charge, tipsRight } = await this.prisma.asSystem(async (tx) => ({
      venue: await tx.venue.findUniqueOrThrow({
        where: { id: display.tenantId },
        select: { name: true, paymentMethods: true, nightSettings: true },
      }),
      // Propinas en el puesto de quien cobra (como en /s y en el PIN): solo con un cobro delante.
      tipsRight:
        display.paymentId || display.chargeId
          ? (await chargeRightsFor(tx, display.tenantId, { userId: display.userId, role: display.role })).tips
          : false,
      payment: display.paymentId
        ? await tx.payment.findFirst({
            where: { id: display.paymentId, tenantId: display.tenantId, createdByUserId: display.userId },
            select: {
              id: true,
              status: true,
              amountCents: true,
              serviceFeeCents: true,
              currency: true,
              qrToken: true,
              qrExpiresAt: true,
              captureMethod: true,
              walletId: true,
            },
          })
        : null,
      charge: display.chargeId
        ? await tx.walletChargeRequest.findFirst({
            where: { id: display.chargeId, tenantId: display.tenantId, requestedByUserId: display.userId },
            select: { id: true, status: true, amountCents: true, expiresAt: true, payToken: true },
          })
        : null,
    }));
    const methods = paymentMethodsOf(venue.paymentMethods);
    const night = nightSettingsOf(venue.nightSettings);
    return screenViewOf({
      venueName: venue.name,
      fichas: methods.wallet && methods.nfc,
      pairedUntil: display.expiresAt,
      payment,
      charge,
      cleared: display.clearedAt !== null,
      now,
      urls: publicBaseUrls(),
      tip: {
        on: methods.tips && tipsRight,
        presets: { flatCents: methods.tipFlatCents, percents: methods.tipPercents },
        // Como al pagar: la propina es entera de la chica que cobra; si cobra otra persona, del local.
        toStaff: display.role === 'OPERATOR',
        chosenCents: display.tipCents,
      },
      pinKeypad: night.pinKeypad,
      noPinMaxCents: night.nfcNoPinMaxCents,
    });
  }

  /**
   * El cliente elige su propina en la tablet (0: «Sin propina»). Solo una de
   * las que se ofrecen y solo en el cobro que enseña. Va en el QR (?tip=) y,
   * si hay cobro del saldo, en él: la ficha (en la tablet o en el móvil del
   * camarero) paga lo vendido + esa propina, también sin PIN.
   */
  async setTip(display: DisplaySession, dto: CustomerDisplayTipDto): Promise<CustomerScreenView> {
    const view = await this.screen(display);
    if (view.state !== 'waiting' || view.key !== dto.key || view.paying) throw notCurrent();
    // «Sin propina», una sugerida u «Otra» (euros enteros hasta el tope, como en /pay).
    const allowed = dto.tipCents === 0 || (view.tip !== null && tipAllowed(dto.tipCents, view.tip.presets, view.tip.maxCents));
    if (!allowed) throw new BadRequestException(BAD_TIP_MESSAGE);
    await this.prisma.asSystem(async (tx) => {
      const saved = await tx.customerDisplay.updateMany({
        where: { id: display.id, tokenHash: display.tokenHash, paymentId: display.paymentId, chargeId: display.chargeId },
        data: { tipCents: dto.tipCents },
      });
      if (saved.count === 0) throw notCurrent();
      // El cobro con ficha, mientras nadie lo esté pagando (sin saldo atado aún).
      if (display.chargeId) {
        await tx.walletChargeRequest.updateMany({
          where: { id: display.chargeId, tenantId: display.tenantId, status: 'PENDING', walletId: null },
          data: { tipCents: dto.tipCents },
        });
      }
    });
    return this.screen({ ...display, tipCents: dto.tipCents });
  }

  /**
   * La ficha acercada a la tablet paga el cobro activo de su camarero, como si
   * la leyera su móvil (mismas reglas: sin PIN hasta el tope de la noche, ficha
   * original, bloqueos). Si hace falta el PIN, dice por qué, sin enseñar nunca
   * el saldo ni el código del cliente.
   */
  async payWithFicha(display: DisplaySession, dto: CustomerDisplayFichaDto): Promise<CustomerDisplayFichaResult> {
    const { chargeId, actor } = fichaTarget(display, dto.key);
    const ref = { card: dto.card, uid: dto.uid ?? null };
    try {
      await this.charges.payQrChargeWithCard(actor, chargeId, ref);
      return { status: 'paid' };
    } catch (err) {
      if (!(err instanceof PinRequiredException)) throw err;
      const wallet = await this.charges.lookupCard(display.tenantId, ref);
      if (wallet.pinLocked) return { status: 'pin_locked' };
      if (!wallet.hasPin) return { status: 'no_pin' };
      const told = err.reason === 'night_cap' || err.reason === 'no_uid' || err.reason === 'tip';
      return { status: 'pin', reason: told ? pinRequiredMessage(err) : null };
    }
  }

  /** Con su PIN, tecleado en la tablet delante del cliente (fallos, bloqueo y topes: los del PIN de siempre). */
  async payWithFichaPin(display: DisplaySession, dto: CustomerDisplayPinDto): Promise<CustomerDisplayFichaResult> {
    const { chargeId, actor } = fichaTarget(display, dto.key);
    await this.charges.payQrChargeWithPin(actor, chargeId, {
      card: dto.card,
      uid: dto.uid ?? null,
      pin: dto.pin,
      ...(typeof dto.tipCents === 'number' ? { tipCents: dto.tipCents } : {}),
    });
    return { status: 'paid' };
  }

  // ─── Lo de dentro ──────────────────────────────────────────────────

  /** La pantalla emparejada de esta persona (sin revocar, caducar ni noche cerrada desde entonces), o null. */
  private async activeOf(owner: DisplayOwner, now: Date) {
    return this.prisma.asSystem(async (tx) => {
      const row = await tx.customerDisplay.findUnique({
        where: { userId: owner.userId },
        select: {
          id: true,
          tenantId: true,
          tokenHash: true,
          pairedAt: true,
          expiresAt: true,
          revokedAt: true,
          paymentId: true,
          chargeId: true,
          clearedAt: true,
        },
      });
      if (!row || row.tenantId !== owner.tenantId || !row.tokenHash || row.revokedAt) return null;
      if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) return null;
      return (await nightClosedSince(tx, row.tenantId, row.pairedAt)) ? null : row;
    });
  }

  /** Solo un cobro suyo y de su local (el de tarjeta y/o el del saldo). */
  private async assertOwnCharge(owner: DisplayOwner, paymentId: string | null, chargeId: string | null): Promise<void> {
    const [payment, charge] = await this.prisma.asSystem(async (tx) => [
      paymentId
        ? await tx.payment.findFirst({
            where: { id: paymentId, tenantId: owner.tenantId, createdByUserId: owner.userId },
            select: { id: true },
          })
        : null,
      chargeId
        ? await tx.walletChargeRequest.findFirst({
            where: { id: chargeId, tenantId: owner.tenantId, requestedByUserId: owner.userId },
            select: { id: true },
          })
        : null,
    ]);
    if ((paymentId && !payment) || (chargeId && !charge)) throw new NotFoundException(CHARGE_NOT_FOUND_MESSAGE);
  }

  /** Fuera la credencial y el cobro; sus conexiones del tiempo real, cortadas. */
  private async revoke(
    displayId: string,
    owner: DisplayOwner,
    actorId: string | null,
    by: 'staff' | 'display',
    tokenHash?: string,
  ): Promise<void> {
    const revoked = await this.prisma.asSystem((tx) =>
      tx.customerDisplay.updateMany({
        // Desde la tablet, solo con su credencial; desde la app, la que haya (y el código pendiente).
        where: { id: displayId, ...(tokenHash ? { tokenHash } : {}) },
        data: { tokenHash: null, expiresAt: null, revokedAt: new Date(), pairingCodeHash: null, pairingCodeExpiresAt: null, ...NO_SHOW },
      }),
    );
    this.realtime.closeDisplay(displayId);
    if (revoked.count === 0) return;
    await this.audit.log({
      action: 'customer_display.unpaired',
      tenantId: owner.tenantId,
      actorId,
      // Como al pedir el código y al emparejar: la persona de esa pantalla.
      targetType: 'CustomerDisplay',
      targetId: owner.userId,
      payload: { by },
    });
  }
}

/** 409: lo que pidió la tablet era para otro cobro (o ya no está en la pantalla). */
function notCurrent(): ConflictException {
  return new ConflictException({ message: NOT_CURRENT_MESSAGE, code: NOT_CURRENT_CODE });
}

/** Solo el cobro del saldo que enseña ahora (sin que el camarero haya salido), y como su camarero. */
function fichaTarget(display: DisplaySession, key: string) {
  if (!display.chargeId || display.clearedAt || displayKey(display.paymentId, display.chargeId) !== key) throw notCurrent();
  return { chargeId: display.chargeId, actor: { userId: display.userId, role: display.role, tenantId: display.tenantId } };
}

/** El texto del 409 PIN_REQUIRED («Ya lleva el tope sin PIN de esta noche…»). */
function pinRequiredMessage(err: PinRequiredException): string | null {
  const body = err.getResponse() as { message?: unknown };
  return typeof body?.message === 'string' ? body.message : null;
}
