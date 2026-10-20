import { describe, expect, it } from 'vitest';
import type { ApprovalView } from '@nightpay/contracts';
import {
  APPROVAL_STATUS,
  approvalReason,
  approvedMessage,
  approveFailure,
  requestSummary,
  approvalTarget,
  approveSummary,
  decidableCount,
  decisionLine,
  expiresIn,
  kindLabel,
  refundGoesToApproval,
  rejectNoteProblem,
  sortApprovals,
  timeAgo,
} from './approvals';
import { formatEur } from './money';

const now = new Date('2026-10-16T02:40:00Z');
const label = (m: string) => (m === 'USDT_TRC20' ? 'USDT TRC20' : m);

const base = {
  id: 'a1',
  status: 'PENDING' as const,
  amountCents: 14_000,
  requestedAt: '2026-10-16T02:00:00.000Z',
  expiresAt: '2026-10-17T02:00:00.000Z',
  requestedBy: { id: 'u-ana', name: 'Ana', role: 'MANAGER' as const },
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  failureReason: null,
  resultRef: null,
  canDecide: true,
};

const payout: ApprovalView = {
  ...base,
  kind: 'PAYOUT',
  payout: {
    operatorId: 'c1',
    operatorName: 'Lola',
    method: 'USDT_TRC20',
    accountMasked: 'T…9f2a',
    payoutLabel: null,
    earningCount: 3,
    externalTxId: null,
    receiptUrl: null,
    notes: ' cierre del jueves ',
  },
};

const refund: ApprovalView = {
  ...base,
  id: 'a2',
  amountCents: 15_000,
  kind: 'REFUND',
  refund: {
    paymentId: 'p1',
    paymentAmountCents: 20_000,
    paymentCreatedAt: '2026-10-16T01:00:00.000Z',
    cardLast4: '4242',
    cardBrand: 'VISA',
    provider: 'PAYTEF',
    reason: null,
  },
};

describe('tarjeta de «Por aprobar»', () => {
  it('qué es y a quién va (cuenta tapada / tarjeta ••4242)', () => {
    expect(kindLabel(payout)).toBe('Pago a chica');
    expect(kindLabel(refund)).toBe('Devolución');
    expect(approvalTarget(payout, label)).toBe('Lola · USDT TRC20 · T…9f2a');
    expect(approvalTarget(refund, label)).toBe(`Cobro de ${formatEur(20_000)} · tarjeta ••4242`);
    expect(approvalTarget({ ...refund, refund: { ...refund.refund, cardLast4: null } }, label)).toBe(`Cobro de ${formatEur(20_000)}`);
  });

  it('el motivo o las notas de quien lo pidió', () => {
    expect(approvalReason(payout)).toBe('cierre del jueves');
    expect(approvalReason(refund)).toBeNull();
  });

  it('la frase antes de aprobar: cuánto, a quién, por dónde, desde qué local; no se deshace', () => {
    expect(approveSummary(payout, 'Luna', label)).toBe(
      `Vas a aprobar el pago de ${formatEur(14_000)} a Lola en USDT TRC20 a T…9f2a desde Luna. No se puede deshacer.`,
    );
    expect(approveSummary(refund, 'Luna', label)).toBe(
      `Vas a aprobar devolver ${formatEur(15_000)} a la tarjeta ••4242 desde Luna. No se puede deshacer.`,
    );
  });

  it('hace cuánto y cuándo caduca', () => {
    expect(timeAgo('2026-10-16T02:00:00Z', now)).toBe('hace 40 min');
    expect(timeAgo('2026-10-16T02:39:30Z', now)).toBe('ahora');
    expect(timeAgo('2026-10-15T20:00:00Z', now)).toBe('hace 6 h');
    expect(expiresIn('2026-10-17T02:00:00Z', now)).toBe('caduca en 23 h');
    expect(expiresIn('2026-10-16T02:50:00Z', now)).toBe('caduca en 10 min');
    expect(expiresIn('2026-10-16T02:00:00Z', now)).toBe('caducada');
  });

  it('estado en una línea para el encargado («Mis solicitudes»)', () => {
    expect(decisionLine(payout, now)).toBe('Pedida hace 40 min · caduca en 23 h');
    expect(
      decisionLine({ ...payout, status: 'APPROVED', decidedAt: '2026-10-16T02:30:00Z', decidedBy: { id: 'j', name: 'Jefe', role: 'OWNER' } }, now),
    ).toBe('Aprobada por Jefe hace 10 min');
    expect(
      decisionLine({ ...payout, status: 'REJECTED', decisionNote: 'ya se pagó', decidedBy: { id: 'j', name: 'Jefe', role: 'OWNER' } }, now),
    ).toBe('Rechazada por Jefe: ya se pagó');
    expect(decisionLine({ ...payout, status: 'FAILED', failureReason: 'El saldo cambió' }, now)).toBe('No se pudo hacer: El saldo cambió');
    expect(decisionLine({ ...payout, status: 'EXPIRED' }, now)).toMatch(/^Caducó sin decidir/);
    expect(APPROVAL_STATUS.PENDING).toEqual({ label: 'Esperando al dueño', tone: 'warning' });
  });

  it('orden: pendientes (la más antigua arriba) y luego lo decidido (lo último arriba)', () => {
    const older = { ...payout, id: 'old', requestedAt: '2026-10-16T01:00:00Z' };
    const doneA = { ...refund, id: 'dA', status: 'APPROVED' as const, decidedAt: '2026-10-16T02:10:00Z' };
    const doneB = { ...refund, id: 'dB', status: 'REJECTED' as const, decidedAt: '2026-10-16T02:20:00Z' };
    expect(sortApprovals([doneA, payout, doneB, older]).map((i) => i.id)).toEqual(['old', 'a1', 'dB', 'dA']);
  });

  it('el globo: solo las pendientes que quien mira puede decidir', () => {
    expect(decidableCount(null)).toBeNull();
    expect(decidableCount([payout, { ...refund, canDecide: false }, { ...payout, id: 'x', status: 'APPROVED' }])).toBe(1);
  });

  it('al aprobar y al pedir', () => {
    expect(approvedMessage(payout)).toBe(`Aprobado: pago de ${formatEur(14_000)} a Lola apuntado.`);
    expect(approvedMessage(refund)).toBe(`Aprobada: devolución de ${formatEur(15_000)} hecha.`);
    expect(requestSummary({ kind: 'PAYOUT', amountCents: 14_000, to: 'Lola', venueName: 'Luna' })).toBe(
      `Vas a pedir al dueño que apruebe pagar ${formatEur(14_000)} a Lola desde Luna. No se mueve dinero hasta que lo apruebe.`,
    );
    expect(requestSummary({ kind: 'REFUND', amountCents: 15_000, to: 'a la tarjeta ••4242', venueName: 'Luna' })).toMatch(
      /^Vas a pedir al dueño que apruebe devolver .* a la tarjeta ••4242 desde Luna\./,
    );
  });

  it('si falla «Aprobar»: qué se hace en cada caso', () => {
    expect(approveFailure(null)).toMatchObject({ kind: 'done', tone: 'warning', text: expect.stringMatching(/puede que sí se aprobara/) });
    expect(approveFailure({ status: 0, code: null, message: 'sin red' })).toMatchObject({ kind: 'done' });
    expect(approveFailure({ status: 409, code: 'APPROVAL_FAILED', message: 'No se ha podido hacer: x' })).toEqual({
      kind: 'done',
      tone: 'danger',
      text: 'No se ha podido hacer: x',
    });
    // La cifra (o la cuenta) cambió entre pedirlo y aprobarlo: no se pagó nada; arriba y en rojo, con qué hacer.
    expect(
      approveFailure({
        status: 409,
        code: 'PAYOUT_CHANGED',
        message: 'No se ha pagado nada: El saldo de la chica ha cambiado desde que se pidió (ahora 310,00 €)',
      }),
    ).toEqual({
      kind: 'done',
      tone: 'danger',
      text:
        'No se ha pagado nada: El saldo de la chica ha cambiado desde que se pidió (ahora 310,00 €). ' +
        'La solicitud queda como «No se pudo hacer»: que el encargado la pida otra vez con lo de ahora.',
    });
    expect(approveFailure({ status: 409, code: 'PAYOUT_CHANGED', message: '' })).toMatchObject({
      kind: 'done',
      text: expect.stringMatching(/^No se ha pagado nada/),
    });
    expect(approveFailure({ status: 502, code: 'REFUND_OUTCOME_UNKNOWN', message: 'No sabemos' })).toMatchObject({ tone: 'warning' });
    // Un 5xx del proxy después de ejecutarse: puede que sí se aprobara (mirar la lista).
    for (const status of [500, 502, 504]) {
      expect(approveFailure({ status, code: null, message: 'Bad gateway' })).toMatchObject({
        kind: 'done',
        tone: 'warning',
        text: expect.stringMatching(/puede que sí se aprobara/),
      });
    }
    expect(approveFailure({ status: 403, code: 'TOTP_NOT_ENROLLED', message: 'x' })).toMatchObject({
      kind: 'enrol',
      text: expect.stringMatching(/Ajustes → Verificación en dos pasos/),
    });
    expect(approveFailure({ status: 403, code: 'TOTP_INVALID', message: 'Código malo' })).toEqual({
      kind: 'retry',
      text: 'Código malo',
      clearCode: true,
    });
    expect(approveFailure({ status: 403, code: 'APPROVAL_OWN_REQUEST', message: 'Lo tuyo no' })).toMatchObject({
      kind: 'retry',
      clearCode: false,
    });
  });

  it('rechazar pide el motivo', () => {
    expect(rejectNoteProblem('  ')).toMatch(/motivo|por qué/);
    expect(rejectNoteProblem('ya se le pagó')).toBeNull();
  });

  it('la devolución se pide al dueño desde el umbral (incluido); el dueño nunca', () => {
    expect(refundGoesToApproval(10_000, 10_000)).toBe(true);
    expect(refundGoesToApproval(10_000, 9_999)).toBe(false);
    expect(refundGoesToApproval(null, 1_000_000)).toBe(false);
    expect(refundGoesToApproval(10_000, Number.NaN)).toBe(false);
  });
});
