import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CANCEL_AT_BANK_AFTER_MS, cancelAtBankWaitMs } from '@nightpay/contracts';
import { assertBankWaitOver, bankVisitsSince, cancelTooSoon, cancelWaitMsOf, isAtBank } from './cancel-at-bank';

const SALA = '0a0a0a0a-1111-4222-8333-444444444444';
const C1 = '11111111-2222-4333-8444-555555555555';
const C2 = '22222222-3333-4444-8555-666666666666';
const NOW = new Date('2026-11-16T23:40:00.000Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

function sqlOf(strings: unknown): string {
  return Array.isArray(strings) ? (strings as string[]).join('$') : String(strings);
}

describe('la regla: 2 minutos con el cliente en su banco', () => {
  it('es una constante con nombre: 2 minutos', () => {
    expect(CANCEL_AT_BANK_AFTER_MS).toBe(120_000);
  });

  it('lo que falta: a los 30 s, 90 s; a los 2 min o después, 0; sin saber desde cuándo, 0', () => {
    expect(cancelAtBankWaitMs(ago(30).getTime(), NOW.getTime())).toBe(90_000);
    expect(cancelAtBankWaitMs(ago(120).getTime(), NOW.getTime())).toBe(0);
    expect(cancelAtBankWaitMs(ago(600).getTime(), NOW.getTime())).toBe(0);
    expect(cancelAtBankWaitMs(null, NOW.getTime())).toBe(0);
    expect(cancelAtBankWaitMs(Number.NaN, NOW.getTime())).toBe(0);
  });

  it('en su banco: AUTHORIZING con una pasarela; con bitcoin o sin empezar, no', () => {
    expect(isAtBank({ status: 'AUTHORIZING', provider: 'REDSYS' })).toBe(true);
    expect(isAtBank({ status: 'AUTHORIZING', provider: 'PAYTEF', posOperationNumber: null })).toBe(true);
    expect(isAtBank({ status: 'AUTHORIZING', provider: null })).toBe(true);
    expect(isAtBank({ status: 'AUTHORIZING', provider: 'BTCPAY' })).toBe(false);
    expect(isAtBank({ status: 'CREATED', provider: null })).toBe(false);
    expect(isAtBank({ status: 'AWAITING_CAPTURE', provider: 'BTCPAY' })).toBe(false);
  });

  it('la recarga cobrada en el datáfono sin comprobar (con su operación) no está en su banco: ni espera ni se cancela', () => {
    expect(isAtBank({ status: 'AUTHORIZING', provider: 'PAYTEF', posOperationNumber: '99812' })).toBe(false);
    const visits = { now: NOW, since: new Map([[C1, ago(10)]]) };
    expect(cancelWaitMsOf({ id: C1, status: 'AUTHORIZING', provider: 'PAYTEF', posOperationNumber: '99812' }, visits)).toBe(0);
  });

  it('cancelWaitMsOf: con la hora de la base, no la del servidor', () => {
    const visits = { now: NOW, since: new Map([[C1, ago(45)]]) };
    expect(cancelWaitMsOf({ id: C1, status: 'AUTHORIZING', provider: 'REDSYS' }, visits)).toBe(75_000);
    expect(cancelWaitMsOf({ id: C1, status: 'AUTHORIZING', provider: 'BTCPAY' }, visits)).toBe(0);
    expect(cancelWaitMsOf({ id: C2, status: 'AUTHORIZING', provider: 'REDSYS' }, visits)).toBe(0);
    expect(cancelWaitMsOf({ id: C1, status: 'AWAITING_CAPTURE', provider: null }, visits)).toBe(0);
  });

  it('el 409 lleva su código y los segundos que faltan (redondeando hacia arriba)', () => {
    const err = cancelTooSoon(89_001);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'CANCEL_AT_BANK_TOO_SOON', retryInSeconds: 90 });
    expect((err.getResponse() as { message: string }).message).toMatch(/su banco/);
  });
});

describe('desde cuándo está en su banco (la base)', () => {
  it('una sola consulta para todos, filtrada por el local; lo más reciente de intento y evento lo calcula la base', async () => {
    const queryRaw = vi.fn(async () => [
      { id: C1, since: ago(30), now: NOW },
      { id: C2, since: null, now: NOW },
    ]);
    const visits = await bankVisitsSince({ $queryRaw: queryRaw } as never, SALA, [C1, C2]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [unknown, ...unknown[]];
    const sql = sqlOf(strings);
    expect(sql).toContain('"tenantId" = $');
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('payment_attempts');
    expect(sql).toContain(`'payment.authorizing'`);
    expect(sql).not.toContain('updatedAt');
    expect(values).toEqual([SALA, [C1, C2]]);
    expect(visits.now).toEqual(NOW);
    expect(visits.since.get(C1)).toEqual(ago(30));
    expect(visits.since.has(C2)).toBe(false);
  });

  it('sin cobros en su banco no se pregunta a la base', async () => {
    const queryRaw = vi.fn();
    const visits = await bankVisitsSince({ $queryRaw: queryRaw } as never, SALA, []);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(visits.since.size).toBe(0);
  });

  it('assertBankWaitOver: antes de tiempo, 409; pasados los 2 min o con bitcoin, nada', async () => {
    const db = (since: Date | null) => ({ $queryRaw: vi.fn(async () => [{ id: C1, since, now: NOW }]) });
    const locked = { id: C1, tenantId: SALA, status: 'AUTHORIZING', provider: 'REDSYS' };
    await expect(assertBankWaitOver(db(ago(10)) as never, locked)).rejects.toMatchObject({ response: { code: 'CANCEL_AT_BANK_TOO_SOON', retryInSeconds: 110 } });
    await expect(assertBankWaitOver(db(ago(130)) as never, locked)).resolves.toBeUndefined();
    const bitcoin = db(ago(1));
    await expect(assertBankWaitOver(bitcoin as never, { ...locked, provider: 'BTCPAY' })).resolves.toBeUndefined();
    expect(bitcoin.$queryRaw).not.toHaveBeenCalled();
    // La recarga cobrada en el datáfono no cuenta aquí: cancel() la rechaza antes (CANCEL_HELD_ON_READER).
    const reader = db(ago(1));
    await expect(assertBankWaitOver(reader as never, { ...locked, provider: 'PAYTEF', posOperationNumber: '99812' })).resolves.toBeUndefined();
    expect(reader.$queryRaw).not.toHaveBeenCalled();
  });
});
