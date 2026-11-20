import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { notifyPayoutAccountChanged, payoutAccountTooNew, payoutChangedEmail } from './payout-account-notices';

const IBAN = 'ES9121000418450200051332';
const AT = new Date('2026-11-19T22:10:00.000Z');
const HOLD = new Date('2026-11-21T22:10:00.000Z');

describe('correo a la compañera: «Tu cuenta de cobro ha cambiado»', () => {
  it('con la cuenta tapada, la fecha (hora de Madrid) y qué hacer si no fue ella; nunca la cuenta entera', () => {
    const mail = payoutChangedEmail({ venueName: 'Sala <Luna>', name: 'Ana', masked: 'ES91 •••• •••• 1332', method: 'SEPA_IBAN', at: AT, holdUntil: HOLD });
    expect(mail.subject).toBe('Tu cuenta de cobro en Sala <Luna> ha cambiado');
    expect(mail.text).toContain('Hola Ana');
    expect(mail.text).toContain('ES91 •••• •••• 1332');
    expect(mail.text).toContain('19 de noviembre a las 23:10');
    expect(mail.text).toContain('21 de noviembre a las 23:10');
    expect(mail.text).toMatch(/Si no lo has pedido tú/);
    expect(mail.html).toContain('Sala &lt;Luna&gt;');
    expect(`${mail.text}${mail.html}${mail.subject}`).not.toContain(IBAN);
  });

  it('en efectivo o sin cuenta lo dice así (sin espera)', () => {
    const cash = payoutChangedEmail({ venueName: 'Luna', name: null, masked: null, method: 'MANUAL_CASH', at: AT, holdUntil: null });
    expect(cash.text).toContain('Hola,');
    expect(cash.text).toContain('Ahora cobras en efectivo');
    expect(cash.text).not.toContain('a partir del');
    const none = payoutChangedEmail({ venueName: 'Luna', name: 'Ana', masked: null, method: null, at: AT, holdUntil: null });
    expect(none.text).toContain('Ya no tienes cuenta de cobro');
  });
});

describe('notifyPayoutAccountChanged — registro (para Incidencias y Telegram) y correo', () => {
  const base = {
    tenantId: 't-1',
    actorId: 'u-owner',
    via: 'panel' as const,
    operator: { id: 'op-1', email: 'ana@x.es', displayName: 'Ana' },
    venueName: 'Luna',
    before: { method: 'SEPA_IBAN' as const, address: IBAN, metadata: { accountHolder: 'Ana López' }, label: null },
    after: { method: 'SEPA_IBAN' as const, address: 'ES7921000813610123456789', metadata: { accountHolder: 'Svetlana Ivanova' }, label: null },
    at: AT,
    holdUntil: HOLD,
  };

  it('apunta la acción delicada con todo tapado (y si el titular no se parece) y manda el correo', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const email = { send: vi.fn().mockResolvedValue({ ok: true, delivered: true }), isEnabled: () => true };
    await notifyPayoutAccountChanged({ audit, email }, base);
    const entry = audit.log.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: 'operator.payout_account_changed',
      tenantId: 't-1',
      actorId: 'u-owner',
      targetType: 'User',
      targetId: 'op-1',
      payload: {
        via: 'panel',
        name: 'Ana',
        holderMismatch: true,
        holdUntil: HOLD.toISOString(),
        emailed: true,
        before: { payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES91 •••• •••• 1332', payoutHolder: 'A••• L•••' },
        after: { payoutMethod: 'SEPA_IBAN', payoutAddress: 'ES79 •••• •••• 6789', payoutHolder: 'S••• I•••' },
      },
    });
    expect(JSON.stringify(entry)).not.toContain(IBAN);
    expect(JSON.stringify(entry)).not.toContain('Ivanova');
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@x.es', subject: 'Tu cuenta de cobro en Luna ha cambiado' }));
  });

  it('un correo que falla no deshace nada (el cambio ya está guardado y en el registro)', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const email = { send: vi.fn().mockRejectedValue(new Error('smtp caído')), isEnabled: () => true };
    const logger = { error: vi.fn() };
    await expect(notifyPayoutAccountChanged({ audit, email, logger }, base)).resolves.toBeUndefined();
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    expect(String(logger.error.mock.calls[0]![0])).not.toContain(IBAN);
  });

  it('el titular que sí se parece no se marca', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const email = { send: vi.fn().mockResolvedValue({ ok: true, delivered: false }), isEnabled: () => false };
    await notifyPayoutAccountChanged({ audit, email }, { ...base, after: { ...base.after, metadata: { accountHolder: 'Ana María Ruiz' } } });
    expect(audit.log.mock.calls[0]![0].payload.holderMismatch).toBe(false);
  });

  it('sin el correo activado (sin RESEND_API_KEY) lo apunta, para que la incidencia no lo prometa', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const email = { send: vi.fn().mockResolvedValue({ ok: true, delivered: false }), isEnabled: () => false };
    await notifyPayoutAccountChanged({ audit, email }, base);
    expect(audit.log.mock.calls[0]![0].payload.emailed).toBe(false);
  });
});

describe('payoutAccountTooNew — 48 h sin pagar a una cuenta recién cambiada', () => {
  const NOW = new Date('2026-11-19T22:00:00.000Z');
  const until = new Date('2026-11-21T21:30:00.000Z');

  it('aún en espera y no es en efectivo: 409 con el código y la fecha desde la que se puede', () => {
    const err = payoutAccountTooNew({ displayName: ' Ana ', payoutHoldUntil: until }, 'SEPA_IBAN', NOW);
    expect(err).toBeInstanceOf(ConflictException);
    const body = err!.getResponse() as { code: string; payableFrom: string; message: string };
    expect(body.code).toBe('PAYOUT_ACCOUNT_TOO_NEW');
    expect(body.payableFrom).toBe(until.toISOString());
    expect(body.message).toContain('La cuenta de cobro de Ana cambió hace menos de 48 h');
    expect(body.message).toContain('21 de noviembre a las 22:30');
    expect(body.message).toContain('En efectivo, sí');
  });

  it('por otra vía que no sea efectivo, también espera (no se salta eligiendo otro método)', () => {
    expect(payoutAccountTooNew({ payoutHoldUntil: until }, 'USDT_TRC20', NOW)).toBeInstanceOf(ConflictException);
    expect(payoutAccountTooNew({ payoutHoldUntil: until }, null, NOW)).toBeInstanceOf(ConflictException);
  });

  it('en efectivo, pasada la espera o sin espera: nada', () => {
    expect(payoutAccountTooNew({ payoutHoldUntil: until }, 'MANUAL_CASH', NOW)).toBeNull();
    expect(payoutAccountTooNew({ payoutHoldUntil: until }, 'SEPA_IBAN', until)).toBeNull();
    expect(payoutAccountTooNew({ payoutHoldUntil: null }, 'SEPA_IBAN', NOW)).toBeNull();
    expect(payoutAccountTooNew({}, 'SEPA_IBAN', NOW)).toBeNull();
  });
});
