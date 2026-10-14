import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InvalidTransitionError, type PaymentMachineState } from '../payments/payment.machine';
import { PAID_STATES, confirmationCode } from '../payments/pay-redirect';
import { PaymentsService } from '../payments/payments.service';
import { settleChargedTip } from '../payments/tip';
import type { PosDevice } from './device.guard';
import {
  PAIRING_CODE_TTL_MS,
  cardBrandOf,
  formatPairingCode,
  last4Of,
  newDeviceToken,
  newPairingCode,
  normalizePairingCode,
  operationNumberOf,
  payMethodCodeOf,
  posReference,
  sha256,
  shiftAmountCents,
  type PaytefSaleResult,
  type PaytefShiftOperation,
} from './paytef';

export interface PendingPosCharge {
  id: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  createdByName: string;
  zone: string | null;
  terminalLabel: string | null;
  code: string;
  /** Asignado a este datáfono o a su zona: va primero. */
  forThisTerminal: boolean;
}

export type SaleOutcome =
  | { status: 'PAID'; code: string; message: string }
  | { status: 'DECLINED'; message: string }
  | { status: 'DUPLICATE'; message: string; operationNumber: string }
  | { status: 'MISMATCH'; message: string; operationNumber: string | null };

export interface ShiftSummary {
  total: number;
  matched: number;
  unmatched: Array<{ operationNumber: string; amountCents: number | null; occurredAt: string | null }>;
}

type PosPayment = {
  id: string;
  tenantId: string;
  status: string;
  captureMethod: string | null;
  amountCents: number;
  currency: string;
  qrExpiresAt: Date;
  posOperationNumber: string | null;
  posTerminalId: string | null;
  tipGoesTo: string | null;
  createdBy: { role: string } | null;
};

/** Un cobro tiene que haberse iniciado en el mismo datáfono hace poco. */
const START_VALID_MS = 15 * 60 * 1000;
/** Propina pedida en el datáfono: como mucho el importe y nunca más de esto. */
const MAX_TERMINAL_TIP_CENTS = 500_00;

/**
 * Datáfono PAX con la app NightPay. El datáfono pide el cobro, manda el
 * importe al lector (Device API de Paytef) y nos devuelve el resultado: el
 * cobro queda pagado y asignado a la chica sin teclear nada.
 */
@Injectable()
export class PosDeviceService {
  private readonly logger = new Logger(PosDeviceService.name);
  private readonly prisma: PrismaService;
  private readonly payments: PaymentsService;
  private readonly audit: AuditService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(PaymentsService) payments: PaymentsService,
    @Inject(AuditService) audit: AuditService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.payments = payments;
    this.audit = audit;
    this.cls = cls;
  }

  // ─── Vinculación (panel del dueño) ─────────────────────────────────────

  async createPairingCode(
    tenantId: string,
    terminalId: string,
    actorId: string,
  ): Promise<{ code: string; expiresAt: string }> {
    await this.terminalOf(tenantId, terminalId);
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    await this.prisma.asSystem((tx) =>
      tx.terminal.update({
        where: { id: terminalId },
        data: { pairingCodeHash: sha256(code), pairingCodeExpiresAt: expiresAt },
      }),
    );
    await this.audit.log({
      action: 'terminal.pairing_code.created',
      tenantId,
      actorId,
      targetType: 'Terminal',
      targetId: terminalId,
      payload: { expiresAt: expiresAt.toISOString() },
    });
    return { code: formatPairingCode(code), expiresAt: expiresAt.toISOString() };
  }

  async unpair(tenantId: string, terminalId: string, actorId: string): Promise<void> {
    await this.terminalOf(tenantId, terminalId);
    await this.prisma.asSystem((tx) =>
      tx.terminal.update({
        where: { id: terminalId },
        data: { deviceTokenHash: null, devicePairedAt: null, pairingCodeHash: null, pairingCodeExpiresAt: null },
      }),
    );
    await this.audit.log({
      action: 'terminal.device.unpaired',
      tenantId,
      actorId,
      targetType: 'Terminal',
      targetId: terminalId,
      payload: {},
    });
  }

  /** El datáfono canjea el código por su credencial (una sola vez). */
  async pair(rawCode: string): Promise<{ token: string; terminal: { label: string; zone: string | null }; venueName: string }> {
    const code = normalizePairingCode(rawCode);
    const terminal = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({
        where: { pairingCodeHash: sha256(code), pairingCodeExpiresAt: { gt: new Date() }, active: true },
        select: { id: true, tenantId: true, label: true, zone: true, venue: { select: { name: true } } },
      }),
    );
    if (!terminal) throw new NotFoundException('Código no válido o caducado. Genera otro en el panel.');
    const token = newDeviceToken();
    // Canje condicionado: dos datáfonos con el mismo código, solo uno gana.
    const redeemed = await this.prisma.asSystem((tx) =>
      tx.terminal.updateMany({
        where: { id: terminal.id, pairingCodeHash: sha256(code), pairingCodeExpiresAt: { gt: new Date() } },
        data: {
          deviceTokenHash: sha256(token),
          devicePairedAt: new Date(),
          deviceLastSeenAt: new Date(),
          pairingCodeHash: null,
          pairingCodeExpiresAt: null,
        },
      }),
    );
    if (redeemed.count === 0) throw new NotFoundException('Código no válido o caducado. Genera otro en el panel.');
    await this.audit.log({
      action: 'terminal.device.paired',
      tenantId: terminal.tenantId,
      targetType: 'Terminal',
      targetId: terminal.id,
      payload: {},
    });
    return { token, terminal: { label: terminal.label, zone: terminal.zone }, venueName: terminal.venue.name };
  }

  async me(device: PosDevice): Promise<{ terminal: { label: string; zone: string | null }; venueName: string }> {
    const venue = await this.prisma.venue.findUnique({ where: { id: device.tenantId }, select: { name: true } });
    return { terminal: { label: device.label, zone: device.zone }, venueName: venue?.name ?? '' };
  }

  // ─── Cobros ────────────────────────────────────────────────────────────

  /** Cobros por datáfono que esperan a ser cobrados en el local. */
  async pending(device: PosDevice): Promise<PendingPosCharge[]> {
    const rows = await this.prisma.asSystem((tx) =>
      tx.payment.findMany({
        where: {
          tenantId: device.tenantId,
          status: 'CREATED',
          captureMethod: 'POS_EXTERNAL',
          qrExpiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: {
          id: true,
          amountCents: true,
          currency: true,
          createdAt: true,
          terminalId: true,
          createdBy: { select: { displayName: true, email: true } },
          terminal: { select: { zone: true, label: true } },
        },
      }),
    );
    const mine = (r: (typeof rows)[number]): boolean =>
      r.terminalId === device.terminalId || (device.zone !== null && r.terminal?.zone === device.zone);
    return rows
      .map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        currency: r.currency,
        createdAt: r.createdAt.toISOString(),
        createdByName: r.createdBy?.displayName ?? r.createdBy?.email ?? '—',
        zone: r.terminal?.zone ?? null,
        terminalLabel: r.terminal?.label ?? null,
        code: confirmationCode(r.id),
        forThisTerminal: mine(r),
      }))
      .sort((a, b) => Number(b.forThisTerminal) - Number(a.forThisTerminal));
  }

  /** Antes de mandar el importe al lector: comprueba el cobro y da la referencia. */
  async start(
    device: PosDevice,
    paymentId: string,
  ): Promise<{ reference: string; amountCents: number; currency: string }> {
    const p = await this.paymentOf(device, paymentId);
    if (p.captureMethod !== 'POS_EXTERNAL' || p.status !== 'CREATED') {
      throw new ConflictException('Este cobro ya no está pendiente');
    }
    if (p.qrExpiresAt <= new Date()) throw new ConflictException('Este cobro ha caducado: que la chica cree otro');
    await this.event(p, 'pos.device_started', { terminalId: device.terminalId });
    return { reference: posReference(p.id), amountCents: p.amountCents, currency: p.currency };
  }

  /**
   * Resultado de la venta en el lector. Aprobada → cobro pagado (como un
   * POS confirmado, con la comisión de la chica). Si el dinero se cobró pero
   * el cobro ya no admitía pago (pagado, caducado, otro importe), queda como
   * incidencia y el datáfono pide anularla.
   */
  async reportResult(device: PosDevice, paymentId: string, r: PaytefSaleResult): Promise<SaleOutcome> {
    const p = await this.paymentOf(device, paymentId);
    const op = operationNumberOf(r);
    await this.event(p, 'pos.device_result', sanitizeResult(r, device.terminalId));

    if (!r.approved) {
      return { status: 'DECLINED', message: r.resultText?.trim() || 'Tarjeta denegada. Prueba con otra.' };
    }
    // Una venta aprobada trae siempre su operación, su referencia y su importe.
    if (!op) throw new BadRequestException('Falta el número de operación de Paytef');
    if (r.transactionReference !== posReference(p.id)) {
      throw new BadRequestException('Esta operación del datáfono no es de este cobro');
    }
    if (r.requestedAmount === undefined) throw new BadRequestException('Falta el importe cobrado');

    // Reintento del mismo resultado (p. ej. se cortó la red al confirmarlo).
    if (
      p.posOperationNumber === op &&
      p.posTerminalId === device.terminalId &&
      PAID_STATES.has(p.status as PaymentMachineState)
    ) {
      return this.paid(p.id);
    }
    if (r.requestedAmount !== p.amountCents) {
      return this.mismatch(p, op, `Se cobraron ${eur(r.requestedAmount)} y el cobro era de ${eur(p.amountCents)}: anula esta operación.`);
    }
    if (PAID_STATES.has(p.status as PaymentMachineState)) return this.duplicate(p, op, device);
    if (p.captureMethod !== 'POS_EXTERNAL' || p.status !== 'CREATED') {
      return this.mismatch(p, op, 'El cobro ya no estaba abierto (caducado o cancelado): anula esta operación.');
    }
    if (!(await this.startedHere(p.id, device.terminalId))) {
      return this.mismatch(p, op, 'Este cobro no se inició en este datáfono: anula esta operación.');
    }
    const tip = r.tipAmount ?? 0;
    if (tip > Math.min(p.amountCents, MAX_TERMINAL_TIP_CENTS)) {
      return this.mismatch(p, op, `Propina de ${eur(tip)} fuera de lo normal: anula esta operación.`);
    }

    const authCode = r.authorisationCode?.trim().toUpperCase() || null;
    try {
      // Operación, tarjeta y propina en la MISMA transacción que lo marca
      // pagado y reparte la comisión: o queda todo, o nada.
      await this.payments.transition(
        p.id,
        { type: 'POS_CONFIRMED', posReceiptRef: authCode ?? op },
        p.tenantId,
        {
          prepare: async (tx, locked) => {
            const settled =
              tip > 0
                ? settleChargedTip({
                    amountCents: locked.amountCents,
                    tipCents: tip,
                    tipGoesTo: locked.tipGoesTo,
                    creatorRole: p.createdBy?.role ?? null,
                  })
                : null;
            await tx.paymentEvent.create({
              data: {
                paymentId: p.id,
                tenantId: p.tenantId,
                eventType: 'pos.device_confirmed',
                payload: { operationNumber: op, terminalId: device.terminalId },
                traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
              },
            });
            await tx.payment.update({
              where: { id: p.id },
              data: {
                posOperationNumber: op,
                posTerminalId: device.terminalId,
                terminalId: device.terminalId,
                authCode,
                authorizedAt: new Date(),
                cardLast4: last4Of(r),
                cardBrand: cardBrandOf(r),
                payMethodCode: payMethodCodeOf(r),
                ...(settled ?? {}),
              },
            });
            return { provider: 'PAYTEF', providerTxId: op, ...(settled ?? {}) };
          },
        },
      );
    } catch (err) {
      const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!conflict && !(err instanceof InvalidTransitionError)) throw err;
      // Cambió mientras se cobraba. Si quedó pagado con ESTA operación de ESTE
      // datáfono, era el mismo resultado enviado dos veces: está pagado.
      const now = await this.paymentOf(device, paymentId);
      const paidHere = PAID_STATES.has(now.status as PaymentMachineState);
      if (paidHere && now.posOperationNumber === op && now.posTerminalId === device.terminalId) {
        return this.paid(p.id);
      }
      if (conflict) return this.mismatch(p, op, 'Esta operación del datáfono ya está apuntada en otro cobro.');
      if (paidHere) return this.duplicate(p, op, device);
      return this.mismatch(p, op, 'El cobro ya no estaba abierto: anula esta operación.');
    }

    this.logger.log(`Cobro ${p.id} pagado en el datáfono ${device.terminalId} (operación ${op})`);
    return this.paid(p.id);
  }

  /** El datáfono anuló una operación (doble cobro o importe equivocado). */
  async reportVoid(
    device: PosDevice,
    paymentId: string,
    body: { operationNumber: string; approved: boolean; resultText?: string },
  ): Promise<{ ok: true }> {
    const p = await this.paymentOf(device, paymentId);
    // Solo se anulan operaciones que el servidor ya procesó como cobradas en
    // este cobro (pagado, doble cobro o que no cuadra): un aviso de anulación
    // inventado no esconde una incidencia de otra operación.
    const known = await this.prisma.asSystem((tx) =>
      tx.paymentEvent.count({
        where: {
          paymentId: p.id,
          OR: [
            {
              eventType: { in: ['pos.device_confirmed', 'pos.charge_mismatch'] },
              payload: { path: ['operationNumber'], equals: body.operationNumber },
            },
            { eventType: 'payment.duplicate_charge', payload: { path: ['order'], equals: body.operationNumber } },
          ],
        },
      }),
    );
    if (known === 0) throw new BadRequestException('Esa operación no es de este cobro');
    await this.event(p, body.approved ? 'pos.voided' : 'pos.void_failed', {
      operationNumber: body.operationNumber,
      resultText: body.resultText ?? null,
      terminalId: device.terminalId,
    });
    return { ok: true };
  }

  /**
   * Cuadre con el cierre de jornada del datáfono: guarda sus operaciones y
   * devuelve las ventas que no están en NightPay (también salen en Incidencias).
   */
  async reportShift(device: PosDevice, operations: PaytefShiftOperation[]): Promise<ShiftSummary> {
    const rows = operations.map((o) => ({
      operationNumber: String(o.paytefOperationNumber).trim(),
      opType: (o.opType ?? 'sale').toLowerCase(),
      amountCents: shiftAmountCents(o.amountWithSign),
      occurredAt: parseDate(o.timestamp),
    }));
    if (rows.length > 0) {
      await this.prisma.asSystem((tx) =>
        tx.posTerminalOp.createMany({
          data: rows.map((r) => ({ ...r, tenantId: device.tenantId, terminalId: device.terminalId })),
          skipDuplicates: true,
        }),
      );
    }
    const sales = rows.filter((r) => r.opType === 'sale');
    const known = await this.prisma.asSystem((tx) =>
      tx.payment.findMany({
        where: {
          tenantId: device.tenantId,
          posTerminalId: device.terminalId,
          posOperationNumber: { in: sales.map((s) => s.operationNumber) },
        },
        select: { posOperationNumber: true, amountCents: true, tipCents: true },
      }),
    );
    // Cuadra si la operación está en NightPay por el mismo importe (con propina).
    const charged = new Map(known.map((k) => [k.posOperationNumber, k.amountCents + k.tipCents]));
    const unmatched = sales
      .filter((s) => {
        const amount = charged.get(s.operationNumber);
        return amount === undefined || (s.amountCents !== null && s.amountCents !== amount);
      })
      .map((s) => ({
        operationNumber: s.operationNumber,
        amountCents: s.amountCents,
        occurredAt: s.occurredAt?.toISOString() ?? null,
      }));
    return { total: sales.length, matched: sales.length - unmatched.length, unmatched };
  }

  // ─── Auxiliares ────────────────────────────────────────────────────────

  private async terminalOf(tenantId: string, terminalId: string): Promise<void> {
    const t = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({ where: { id: terminalId, tenantId }, select: { id: true } }),
    );
    if (!t) throw new NotFoundException('Datáfono no encontrado');
  }

  private async paymentOf(device: PosDevice, paymentId: string): Promise<PosPayment> {
    const p = await this.prisma.asSystem((tx) =>
      tx.payment.findFirst({
        where: { id: paymentId, tenantId: device.tenantId },
        select: {
          id: true,
          tenantId: true,
          status: true,
          captureMethod: true,
          amountCents: true,
          currency: true,
          qrExpiresAt: true,
          posOperationNumber: true,
          posTerminalId: true,
          tipGoesTo: true,
          createdBy: { select: { role: true } },
        },
      }),
    );
    if (!p) throw new NotFoundException('Cobro no encontrado');
    return { ...p, status: String(p.status), createdBy: p.createdBy ? { role: String(p.createdBy.role) } : null };
  }

  /** El cobro ya estaba pagado por otra vía: el cliente pagó dos veces. */
  private async duplicate(p: PosPayment, op: string, device: PosDevice): Promise<SaleOutcome> {
    await this.event(p, 'payment.duplicate_charge', { order: op, terminalId: device.terminalId });
    return {
      status: 'DUPLICATE',
      operationNumber: op,
      message: 'Este cobro ya estaba pagado: anula esta operación en el datáfono para no cobrar dos veces.',
    };
  }

  /** ¿Este datáfono pidió este cobro hace poco (/start)? */
  private async startedHere(paymentId: string, terminalId: string): Promise<boolean> {
    const n = await this.prisma.asSystem((tx) =>
      tx.paymentEvent.count({
        where: {
          paymentId,
          eventType: 'pos.device_started',
          occurredAt: { gte: new Date(Date.now() - START_VALID_MS) },
          payload: { path: ['terminalId'], equals: terminalId },
        },
      }),
    );
    return n > 0;
  }

  private paid(paymentId: string): SaleOutcome {
    return { status: 'PAID', code: confirmationCode(paymentId), message: 'Pagado' };
  }

  private async mismatch(p: PosPayment, op: string, message: string): Promise<SaleOutcome> {
    await this.event(p, 'pos.charge_mismatch', { operationNumber: op, message });
    return { status: 'MISMATCH', operationNumber: op, message };
  }

  private async event(p: { id: string; tenantId: string }, eventType: string, payload: Record<string, unknown>) {
    await this.prisma.asSystem((tx) =>
      tx.paymentEvent.create({
        data: {
          paymentId: p.id,
          tenantId: p.tenantId,
          eventType,
          payload: payload as Prisma.InputJsonValue,
          traceId: this.cls.get('ctx')?.traceId ?? randomUUID(),
        },
      }),
    );
  }
}

/** Lo que se guarda del resultado: sin el número de tarjeta enmascarado ni los tickets. */
function sanitizeResult(r: PaytefSaleResult, terminalId: string): Record<string, unknown> {
  return {
    approved: r.approved,
    resultCode: r.resultCode ?? null,
    resultText: r.resultText ?? null,
    authorisationCode: r.authorisationCode ?? null,
    operationNumber: operationNumberOf(r),
    requestedAmount: r.requestedAmount ?? null,
    tipAmount: r.tipAmount ?? null,
    last4: last4Of(r),
    cardTypeCode: r.cardInformation?.cardTypeCode ?? null,
    payMethod: payMethodCodeOf(r),
    pinpadSerialNumber: r.pinpadSerialNumber ?? null,
    terminalId,
  };
}

function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
