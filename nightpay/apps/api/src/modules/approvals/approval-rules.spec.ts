import { describe, it, expect } from 'vitest';
import { BadGatewayException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  APPROVAL_REQUESTED_MESSAGE,
  ApprovalRequestedResponseSchema,
  ApproveApprovalSchema,
  RejectApprovalSchema,
  approvalExpiresAt,
  isApprovalExpired,
  isApprovalRequested,
} from '@nightpay/contracts';
import {
  approvalAlertKey,
  decisionProblem,
  eurShort,
  failureReasonOf,
  isLastingFailure,
  payoutRoute,
  personName,
  refundRoute,
  requestAlertText,
  rulesFor,
} from './approval-rules';

const withApproval = { payoutRequiresApproval: true, refundApprovalThresholdCents: 10_000 };
const without = { payoutRequiresApproval: false, refundApprovalThresholdCents: 10_000 };

describe('quién paga a las chicas y cómo', () => {
  it('el dueño, directo y con 2FA si la tiene (como siempre), pida o no aprobación el local', () => {
    expect(payoutRoute('OWNER', withApproval)).toEqual({ kind: 'direct', twoFactor: 'if_enrolled' });
    expect(payoutRoute('OWNER', without)).toEqual({ kind: 'direct', twoFactor: 'if_enrolled' });
  });

  it('el encargado lo pide si el local lo exige; si no, paga él con 2FA obligatoria', () => {
    expect(payoutRoute('MANAGER', withApproval)).toEqual({ kind: 'request' });
    expect(payoutRoute('MANAGER', without)).toEqual({ kind: 'direct', twoFactor: 'required' });
  });

  it('camareros y chicas, nunca', () => {
    expect(payoutRoute('WAITER', withApproval)).toEqual({ kind: 'forbidden' });
    expect(payoutRoute('OPERATOR', without)).toEqual({ kind: 'forbidden' });
  });
});

describe('devoluciones: desde el umbral del local, el encargado las pide', () => {
  it('umbral incluido (≥), por debajo directa', () => {
    expect(refundRoute('MANAGER', 10_000, withApproval)).toBe('request');
    expect(refundRoute('MANAGER', 25_000, withApproval)).toBe('request');
    expect(refundRoute('MANAGER', 9_999, withApproval)).toBe('direct');
  });

  it('con el umbral que ponga el super-admin (0 = todas)', () => {
    const custom = { payoutRequiresApproval: true, refundApprovalThresholdCents: 50_000 };
    expect(refundRoute('MANAGER', 49_999, custom)).toBe('direct');
    expect(refundRoute('MANAGER', 50_000, custom)).toBe('request');
    expect(refundRoute('MANAGER', 1, { ...custom, refundApprovalThresholdCents: 0 })).toBe('request');
  });

  it('el dueño siempre directa (su 2FA por lo devuelto acumulado sigue igual); el camarero no devuelve', () => {
    expect(refundRoute('OWNER', 1_000_000, withApproval)).toBe('direct');
    expect(refundRoute('WAITER', 100, withApproval)).toBe('forbidden');
  });

  it('lo que necesita el panel: pedir o pagar, y desde cuánto se pide', () => {
    expect(rulesFor('MANAGER', withApproval)).toEqual({
      payoutRequiresApproval: true,
      refundApprovalThresholdCents: 10_000,
      payout: 'request',
      refundRequestFromCents: 10_000,
    });
    expect(rulesFor('MANAGER', without)).toMatchObject({ payout: 'direct_2fa' });
    expect(rulesFor('OWNER', withApproval)).toMatchObject({ payout: 'direct', refundRequestFromCents: null });
    expect(rulesFor('WAITER', withApproval)).toMatchObject({ payout: 'forbidden' });
  });
});

describe('quién decide (separación de funciones)', () => {
  const now = new Date('2026-10-16T03:00:00Z');
  const pending = { requestedById: 'ana', status: 'PENDING' as const, requestedAt: new Date('2026-10-16T02:30:00Z') };

  it('el dueño que no la pidió, pendiente y sin caducar', () => {
    expect(decisionProblem({ userId: 'jefe', role: 'OWNER' }, pending, now)).toBeNull();
  });

  it('quien la pidió no decide, aunque sea dueño (o super-admin)', () => {
    expect(decisionProblem({ userId: 'ana', role: 'OWNER' }, pending, now)).toBe('own_request');
  });

  it('el encargado no decide nada', () => {
    expect(decisionProblem({ userId: 'bea', role: 'MANAGER' }, pending, now)).toBe('not_owner');
  });

  it('ya decidida o caducada (24 h)', () => {
    expect(decisionProblem({ userId: 'jefe', role: 'OWNER' }, { ...pending, status: 'APPROVED' }, now)).toBe('not_pending');
    const old = { ...pending, requestedAt: new Date(now.getTime() - 24 * 3600_000) };
    expect(decisionProblem({ userId: 'jefe', role: 'OWNER' }, old, now)).toBe('expired');
    const almost = { ...pending, requestedAt: new Date(now.getTime() - 24 * 3600_000 + 1000) };
    expect(decisionProblem({ userId: 'jefe', role: 'OWNER' }, almost, now)).toBeNull();
  });

  it('caduca a las 24 h justas', () => {
    const at = new Date('2026-10-16T02:00:00Z');
    expect(approvalExpiresAt(at).toISOString()).toBe('2026-10-17T02:00:00.000Z');
    expect(isApprovalExpired(at, new Date('2026-10-17T01:59:59Z'))).toBe(false);
    expect(isApprovalExpired(at, new Date('2026-10-17T02:00:00Z'))).toBe(true);
  });
});

describe('qué hacer si falla lo aprobado', () => {
  it('ya pagado, no cabe, no encontrado o datos malos → fallida; lo demás (2FA, pasarela, base) no', () => {
    expect(isLastingFailure(new ConflictException('ya pagado'))).toBe(true);
    expect(isLastingFailure(new NotFoundException('no está'))).toBe(true);
    expect(isLastingFailure(new ForbiddenException('2FA'))).toBe(false);
    expect(isLastingFailure(new BadGatewayException('sin confirmar'))).toBe(false);
    expect(isLastingFailure(new Error('conexión'))).toBe(false);
  });

  it('la razón: el mensaje del error, también en cuerpos con código', () => {
    expect(failureReasonOf(new ConflictException({ message: 'Ya se pagó', code: 'X' }))).toBe('Ya se pagó');
    expect(failureReasonOf(new ConflictException('Texto'))).toBe('Texto');
    expect(failureReasonOf(new Error('raro'))).toBe('raro');
    expect(failureReasonOf(new ConflictException('x'.repeat(900))).length).toBe(498);
  });
});

describe('textos', () => {
  it('importes cortos para el móvil', () => {
    expect(eurShort(14_000)).toBe('140 €');
    expect(eurShort(14_050)).toBe('140,50 €');
  });

  it('nombre visible o el principio del email', () => {
    expect(personName({ displayName: ' Ana ', email: 'ana@x.es' })).toBe('Ana');
    expect(personName({ displayName: null, email: 'marta.g@x.es' })).toBe('marta.g');
    expect(personName(null)).toBe('Alguien');
  });

  it('Telegram: quién pide qué, sin datos del cliente', () => {
    expect(
      requestAlertText({ venueName: 'Luna', kind: 'PAYOUT', requester: 'Ana', requesterRole: 'MANAGER', amountCents: 14_000, operatorName: 'Lola' }),
    ).toBe('🔔 Luna: Ana (encargado/a) pide pagar 140 € a Lola. Aprueba en el panel (Por aprobar).');
    expect(
      requestAlertText({ venueName: 'Luna', kind: 'REFUND', requester: 'Ana', requesterRole: 'MANAGER', amountCents: 15_000, paymentAmountCents: 20_000 }),
    ).toBe('🔔 Luna: Ana (encargado/a) pide devolver 150 € de un cobro de 200 €. Aprueba en el panel (Por aprobar).');
  });

  it('la marca de «avisado» es la de la incidencia approval_pending (no se avisa dos veces)', () => {
    expect(approvalAlertKey('t-1', 'a-1')).toBe('np:alert:t-1:approval_pending:a-1');
  });
});

describe('contrato', () => {
  it('202: { approvalRequestId, status: PENDING, … } y el panel lo reconoce', () => {
    const body = {
      approvalRequestId: '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
      status: 'PENDING',
      kind: 'PAYOUT',
      amountCents: 14_000,
      message: APPROVAL_REQUESTED_MESSAGE,
    };
    expect(ApprovalRequestedResponseSchema.parse(body)).toEqual(body);
    expect(isApprovalRequested(body)).toBe(true);
    expect(isApprovalRequested({ id: 'po-1', totalCents: 14_000 })).toBe(false);
    expect(APPROVAL_REQUESTED_MESSAGE).toBe('Pedido al dueño. Te avisamos cuando lo apruebe.');
  });

  it('aprobar pide 6 cifras (con espacio vale); rechazar, el motivo', () => {
    expect(ApproveApprovalSchema.parse({ totpCode: '123 456' })).toEqual({ totpCode: '123456' });
    expect(ApproveApprovalSchema.safeParse({ totpCode: '12345' }).success).toBe(false);
    expect(RejectApprovalSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(RejectApprovalSchema.parse({ note: ' no toca ' })).toEqual({ note: 'no toca' });
  });
});
