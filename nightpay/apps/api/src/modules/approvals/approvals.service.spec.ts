import { describe, it, expect, vi } from 'vitest';
import { BadGatewayException, ConflictException, HttpException } from '@nestjs/common';
import { totpForbidden } from '../auth/totp-code';
import { ApprovalsService } from './approvals.service';
import { ApprovalAlreadyDecidedError } from './approval-store';
import type { ApprovalRow } from './approval-payload';

const T = '00000000-0000-4000-8000-0000000000aa';
const CHICA = '00000000-0000-4000-8000-000000000011';
const PAYMENT = '00000000-0000-4000-8000-000000000022';
const E1 = '00000000-0000-4000-8000-000000000031';
const boss = { userId: 'jefe', role: 'OWNER' as const, tenantId: T };

function payoutRow(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 'ap-1',
    tenantId: T,
    kind: 'PAYOUT',
    status: 'PENDING',
    targetId: CHICA,
    amountCents: 9_000,
    payload: {
      operatorId: CHICA,
      operatorName: 'Lola',
      method: 'USDT_TRC20',
      accountMasked: 'T…9f2a',
      accountFingerprint: 'f',
      payoutLabel: null,
      externalTxId: null,
      receiptUrl: null,
      notes: 'cierre',
      earningIds: [E1],
      debtIds: [],
      holdDays: 0,
    },
    requestedById: 'ana',
    requestedAt: new Date(),
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    resultRef: null,
    failureReason: null,
    ...over,
  };
}

function refundRow(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return payoutRow({
    kind: 'REFUND',
    targetId: PAYMENT,
    amountCents: 15_000,
    payload: {
      paymentId: PAYMENT,
      reason: 'queja',
      paymentAmountCents: 20_000,
      paymentCreatedAt: '2026-10-16T01:00:00.000Z',
      cardLast4: '4242',
      cardBrand: 'VISA',
      provider: 'PAYTEF',
    },
    ...over,
  });
}

/** Cómo queda la fila tras cada lectura: la primera es la de `decidable`. */
function make(opts: { row: ApprovalRow; after?: ApprovalRow | null; refundStatus?: string }) {
  const requests = {
    decidable: vi.fn().mockResolvedValue(opts.row),
    findRow: vi.fn().mockResolvedValue(opts.after === undefined ? { ...opts.row, status: 'APPROVED', resultRef: 'po-1' } : opts.after),
    view: vi.fn(async (_a: unknown, r: ApprovalRow) => ({ id: r.id, status: r.status, resultRef: r.resultRef })),
    markFailed: vi.fn().mockResolvedValue(true),
  };
  const operators = { createPayout: vi.fn().mockResolvedValue({ id: 'po-1' }) };
  const refunds = { refund: vi.fn().mockResolvedValue({ id: 'rf-1', status: 'SUCCEEDED' }) };
  const totp = { assertForUser: vi.fn().mockResolvedValue(undefined) };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const prisma = {
    withTenant: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
      fn({ refund: { findFirst: vi.fn().mockResolvedValue(opts.refundStatus ? { status: opts.refundStatus } : null) } }),
    ),
  };
  const svc = new ApprovalsService(
    prisma as never,
    requests as never,
    operators as never,
    refunds as never,
    totp as never,
    audit as never,
  );
  return { svc, requests, operators, refunds, totp, audit };
}

async function failure(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
}

describe('ApprovalsService.approve', () => {
  it('pago: 2FA del dueño primero; luego createPayout con exactamente lo pedido, marcando la aprobación dentro', async () => {
    const { svc, operators, totp, audit } = make({ row: payoutRow() });
    await expect(svc.approve(boss, 'ap-1', '123456')).resolves.toMatchObject({ status: 'APPROVED', resultRef: 'po-1' });
    expect(totp.assertForUser).toHaveBeenCalledWith('jefe', '123456');
    const [tenant, chica, paidBy, notes, options] = operators.createPayout.mock.calls[0]!;
    expect([tenant, chica, paidBy, notes]).toEqual([T, CHICA, 'jefe', 'cierre']);
    expect(options).toMatchObject({
      externalRail: 'USDT_TRC20',
      exact: { earningIds: [E1], debtIds: [], totalCents: 9_000 },
      approvalRequestId: 'ap-1',
    });
    expect(typeof options.inTransaction).toBe('function');
    expect(typeof options.afterCreate).toBe('function');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.approved', actorId: 'jefe' }));
  });

  it('sin 2FA buena no se hace nada', async () => {
    const { svc, totp, operators } = make({ row: payoutRow() });
    totp.assertForUser.mockRejectedValueOnce(totpForbidden('invalid'));
    expect(await failure(svc.approve(boss, 'ap-1', '000000'))).toMatchObject({ status: 403, body: { code: 'TOTP_INVALID' } });
    expect(operators.createPayout).not.toHaveBeenCalled();
  });

  it('ya aprobada: devuelve cómo quedó sin pedir código ni hacer nada (doble toque)', async () => {
    const { svc, totp, operators } = make({ row: payoutRow({ status: 'APPROVED', resultRef: 'po-1' }) });
    await expect(svc.approve(boss, 'ap-1', '000000')).resolves.toMatchObject({ status: 'APPROVED', resultRef: 'po-1' });
    expect(totp.assertForUser).not.toHaveBeenCalled();
    expect(operators.createPayout).not.toHaveBeenCalled();
  });

  it('otra persona la aprobó a la vez: no se paga otra vez, se devuelve la suya', async () => {
    const { svc, operators, requests } = make({ row: payoutRow() });
    operators.createPayout.mockRejectedValueOnce(new ApprovalAlreadyDecidedError());
    await expect(svc.approve(boss, 'ap-1', '123456')).resolves.toMatchObject({ status: 'APPROVED', resultRef: 'po-1' });
    expect(requests.markFailed).not.toHaveBeenCalled();
  });

  it('… y si la rechazaron a la vez → 409', async () => {
    const { svc, operators } = make({ row: payoutRow(), after: payoutRow({ status: 'REJECTED' }) });
    operators.createPayout.mockRejectedValueOnce(new ApprovalAlreadyDecidedError());
    expect(await failure(svc.approve(boss, 'ap-1', '123456'))).toMatchObject({ status: 409, body: { code: 'APPROVAL_NOT_PENDING' } });
  });

  it('no se puede hacer (ya pagado, saldo distinto…) → FAILED con la razón y 409 APPROVAL_FAILED', async () => {
    const { svc, operators, requests } = make({ row: payoutRow(), after: payoutRow() });
    operators.createPayout.mockRejectedValueOnce(new ConflictException({ message: 'El saldo de la chica ha cambiado', code: 'PAYOUT_CHANGED' }));
    const res = await failure(svc.approve(boss, 'ap-1', '123456'));
    expect(res).toMatchObject({ status: 409, body: { code: 'APPROVAL_FAILED', message: 'No se ha podido hacer: El saldo de la chica ha cambiado' } });
    expect(requests.markFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'ap-1' }), boss, 'El saldo de la chica ha cambiado', 'PENDING');
  });

  it('si otra persona la aprobó mientras fallaba la mía: no se marca FAILED, se devuelve cómo quedó', async () => {
    const { svc, operators, requests } = make({ row: payoutRow(), after: payoutRow() });
    operators.createPayout.mockRejectedValueOnce(new ConflictException('Parte de esas comisiones ya se ha pagado'));
    requests.markFailed.mockResolvedValueOnce(false);
    requests.findRow
      .mockResolvedValueOnce(payoutRow())
      .mockResolvedValueOnce(payoutRow({ status: 'APPROVED', resultRef: 'po-9' }));
    await expect(svc.approve(boss, 'ap-1', '123456')).resolves.toMatchObject({ status: 'APPROVED', resultRef: 'po-9' });
  });

  it('fallo pasajero (base caída): sigue pendiente para reintentar', async () => {
    const { svc, operators, requests } = make({ row: payoutRow(), after: payoutRow() });
    operators.createPayout.mockRejectedValueOnce(new Error('Connection terminated'));
    await expect(svc.approve(boss, 'ap-1', '123456')).rejects.toThrow('Connection terminated');
    expect(requests.markFailed).not.toHaveBeenCalled();
  });

  it('solicitud con datos rotos → FAILED (no se intenta pagar a ciegas)', async () => {
    const { svc, operators, requests } = make({ row: payoutRow({ payload: { operatorId: CHICA } }), after: payoutRow() });
    expect(await failure(svc.approve(boss, 'ap-1', '123456'))).toMatchObject({ status: 409, body: { code: 'APPROVAL_FAILED' } });
    expect(operators.createPayout).not.toHaveBeenCalled();
    expect(requests.markFailed).toHaveBeenCalled();
  });
});

describe('ApprovalsService.approve — devoluciones', () => {
  it('a nombre de quien la pidió, sin volver a pedir 2FA en la devolución, marcando la aprobación al reservar', async () => {
    const { svc, refunds } = make({ row: refundRow(), after: refundRow({ status: 'APPROVED', resultRef: 'rf-1' }) });
    await expect(svc.approve(boss, 'ap-1', '123456')).resolves.toMatchObject({ status: 'APPROVED', resultRef: 'rf-1' });
    const [request, actor, approved] = refunds.refund.mock.calls[0]!;
    expect(request).toEqual({ paymentId: PAYMENT, amountCents: 15_000, reason: 'queja' });
    expect(actor).toEqual({ userId: 'ana', role: 'MANAGER', tenantId: T });
    expect(approved).toMatchObject({ approvalRequestId: 'ap-1', approvedBy: 'jefe' });
  });

  it('la pasarela la rechazó tras aprobarla → FAILED (estaba APPROVED) con la razón', async () => {
    const { svc, refunds, requests } = make({
      row: refundRow(),
      after: refundRow({ status: 'APPROVED', resultRef: 'rf-1' }),
      refundStatus: 'FAILED',
    });
    refunds.refund.mockRejectedValueOnce(new ConflictException('La pasarela rechazó la devolución: no se ha devuelto nada.'));
    expect(await failure(svc.approve(boss, 'ap-1', '123456'))).toMatchObject({ status: 409, body: { code: 'APPROVAL_FAILED' } });
    expect(requests.markFailed).toHaveBeenCalledWith(expect.anything(), boss, expect.stringMatching(/rechazó/), 'APPROVED');
  });

  it('sin confirmar en la pasarela: sigue aprobada (la devolución queda reservada) y se dice tal cual', async () => {
    const { svc, refunds, requests } = make({
      row: refundRow(),
      after: refundRow({ status: 'APPROVED', resultRef: 'rf-1' }),
      refundStatus: 'PENDING',
    });
    refunds.refund.mockRejectedValueOnce(new BadGatewayException({ message: 'No sabemos…', code: 'REFUND_OUTCOME_UNKNOWN' }));
    expect(await failure(svc.approve(boss, 'ap-1', '123456'))).toMatchObject({ status: 502, body: { code: 'REFUND_OUTCOME_UNKNOWN' } });
    expect(requests.markFailed).not.toHaveBeenCalled();
  });
});
