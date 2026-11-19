import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { SuperAdminPayoutAccountsService } from './payout-accounts.service';
import { openPayoutValue, sealPayoutValue } from '../operators/payout-account-crypto';

process.env.ENCRYPTION_KEK ??= 'clave-de-pruebas-de-la-cuenta-de-cobro-0123456789';

const actor = { id: 'c0ffee00-1234-4abc-8def-000000000001', email: 'operaciones@oxiopay.es', ip: '83.45.120.7' };
const BAMBU = { id: '5b8e2c1a-3f4d-4a6b-9c7e-1d2f3a4b5c6d', name: 'Sala Bambú (Madrid)' };
const LUCIA = 'a1c3e5f7-2b4d-4e6f-8a0b-9c8d7e6f5a4b';
const IBAN = 'ES9121000418450200051332';
const TRON = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const EVM = '0x55d398326f99059ff775485246999027b3197955';
const UPDATED_AT = new Date('2026-10-15T09:00:00Z');

function account(id: string, displayName: string, payoutMethod: string | null, payoutAddress: string | null, extra = {}) {
  return {
    id,
    tenantId: BAMBU.id,
    email: `${displayName.toLowerCase()}@salabambu.es`,
    displayName,
    deletedAt: null as Date | null,
    payoutMethod,
    payoutAddress,
    payoutLabel: null as string | null,
    payoutMetadata: null as unknown,
    updatedAt: UPDATED_AT,
    venue: BAMBU,
    ...extra,
  };
}

function setup(opts: { rows?: ReturnType<typeof account>[]; found?: ReturnType<typeof account> | null; stepUpFails?: boolean } = {}) {
  const found = opts.found === undefined ? account(LUCIA, 'Lucía', 'USDT_TRC20', TRON) : opts.found;
  const tx = {
    user: {
      findMany: vi.fn().mockResolvedValue(opts.rows ?? []),
      findFirst: vi.fn().mockResolvedValue(found),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...found!, ...data, updatedAt: UPDATED_AT })),
    },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const stepUp = {
    verify: opts.stepUpFails
      ? vi.fn().mockRejectedValue(new ForbiddenException({ message: 'Código 2FA incorrecto o caducado', code: 'TOTP_INVALID' }))
      : vi.fn().mockResolvedValue(undefined),
  };
  const audit = { write: vi.fn().mockResolvedValue(undefined) };
  const plainAudit = { log: vi.fn().mockResolvedValue(undefined) };
  const email = { send: vi.fn().mockResolvedValue({ ok: true, delivered: true }) };
  const svc = new SuperAdminPayoutAccountsService(prisma as never, stepUp as never, audit as never, plainAudit as never, email as never);
  return { svc, tx, stepUp, audit, plainAudit, email };
}

describe('SuperAdminPayoutAccountsService.list — la lista va tapada', () => {
  it('nunca sale la cuenta entera: IBAN, cripto y email tapados según el método', async () => {
    const { svc } = setup({
      rows: [
        account(LUCIA, 'Lucía', 'SEPA_IBAN', IBAN),
        account('b2c3d4e5-0000-4000-8000-000000000002', 'Carmen', 'USDT_TRC20', TRON),
        account('b2c3d4e5-0000-4000-8000-000000000003', 'Valeria', 'FASTERPAY_EMAIL', 'valeria.rojas@gmail.com'),
        account('b2c3d4e5-0000-4000-8000-000000000004', 'Sofía', 'MANUAL_CASH', null, { deletedAt: new Date('2026-10-01T00:00:00Z') }),
      ],
    });
    const list = await svc.list({});
    expect(list.map((i) => [i.displayName, i.payoutAddressMasked, i.hasPayoutAccount, i.active])).toEqual([
      ['Lucía', 'ES91 •••• •••• 1332', true, true],
      ['Carmen', 'T…uFiV', true, true],
      ['Valeria', 'v•••@gmail.com', true, true],
      ['Sofía', null, false, false],
    ]);
    const json = JSON.stringify(list);
    for (const secret of [IBAN, TRON, 'valeria.rojas@gmail.com']) expect(json).not.toContain(secret);
    expect(list[0]).not.toHaveProperty('payoutAddress');
    expect(list[0]).not.toHaveProperty('payoutMetadata');
    expect(list[0]).toMatchObject({ userId: LUCIA, venue: BAMBU, updatedAt: UPDATED_AT.toISOString() });
  });

  it('cifrada: la tapada guardada aparte, y el titular tapado', async () => {
    const { svc } = setup({
      rows: [
        account(LUCIA, 'Lucía', 'SEPA_IBAN', sealPayoutValue(IBAN, { userId: LUCIA, field: 'address' }), {
          payoutAddressMasked: 'ES91 •••• •••• 1332',
          payoutHolderMasked: 'L••• P•••',
          payoutMetadata: { accountHolder: sealPayoutValue('Lucía Pérez', { userId: LUCIA, field: 'holder' }) },
        }),
      ],
    });
    const [item] = await svc.list({});
    expect(item).toMatchObject({ payoutAddressMasked: 'ES91 •••• •••• 1332', payoutHolderMasked: 'L••• P•••', hasPayoutAccount: true });
    expect(JSON.stringify(item)).not.toContain('pa1:');
  });

  it('por defecto: solo chicas activas de todos los locales, con tope de 1000', async () => {
    const { svc, tx } = setup();
    await svc.list({});
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: 'OPERATOR', deletedAt: null }, take: 1000 }),
    );
  });

  it('filtros: local, método, sin cuenta, también inactivas y búsqueda por nombre o email', async () => {
    const { svc, tx } = setup();
    await svc.list({ venueId: BAMBU.id, method: 'SEPA_IBAN', missing: true, includeInactive: true, q: '  lucía ' });
    expect(tx.user.findMany.mock.calls[0]![0].where).toEqual({
      role: 'OPERATOR',
      tenantId: BAMBU.id,
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: null,
      OR: [
        { email: { contains: 'lucía', mode: 'insensitive' } },
        { displayName: { contains: 'lucía', mode: 'insensitive' } },
      ],
    });
  });

  it('búsqueda en blanco no filtra', async () => {
    const { svc, tx } = setup();
    await svc.list({ q: '   ' });
    expect(tx.user.findMany.mock.calls[0]![0].where).not.toHaveProperty('OR');
  });
});

describe('SuperAdminPayoutAccountsService.reveal — verla entera pide 2FA y queda registrado', () => {
  const dto = { totpCode: '482913', reason: 'La chica dice que no le llega el pago del viernes' };

  it('2FA mala → 403: no se lee la cuenta ni se registra que se vio', async () => {
    const { svc, tx, audit } = setup({ stepUpFails: true });
    await expect(svc.reveal(actor, LUCIA, dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('2FA buena: la cuenta entera, y queda quién la vio, de qué local y por qué', async () => {
    const { svc, stepUp, audit } = setup({ found: account(LUCIA, 'Lucía', 'USDT_TRC20', TRON, { payoutLabel: 'Binance' }) });
    expect(await svc.reveal(actor, LUCIA, dto)).toEqual({
      userId: LUCIA,
      payoutMethod: 'USDT_TRC20',
      payoutAddress: TRON,
      payoutLabel: 'Binance',
      payoutMetadata: null,
    });
    expect(stepUp.verify).toHaveBeenCalledWith(actor, '482913', 'payout_account.reveal');
    expect(audit.write).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: 'payout_account.revealed',
        tenantId: BAMBU.id,
        targetType: 'User',
        targetId: LUCIA,
        reason: dto.reason,
      }),
    );
  });

  it('cifrada: se abre para enseñarla; al registro va la de verdad para que la tape (nunca la cifrada)', async () => {
    const sealed = sealPayoutValue(IBAN, { userId: LUCIA, field: 'address' });
    const { svc, audit } = setup({ found: account(LUCIA, 'Lucía', 'SEPA_IBAN', sealed) });
    expect((await svc.reveal(actor, LUCIA, dto)).payoutAddress).toBe(IBAN);
    expect(audit.write.mock.calls[0]![1].extra).toEqual({ payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN });
  });

  it('no es una chica (o no existe) → 404 y sin registro', async () => {
    const { svc, tx, audit } = setup({ found: null });
    await expect(svc.reveal(actor, LUCIA, dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.user.findFirst.mock.calls[0]![0].where).toEqual({ id: LUCIA, role: 'OPERATOR' });
    expect(audit.write).not.toHaveBeenCalled();
  });
});

describe('SuperAdminPayoutAccountsService.update — cambiarla pide 2FA, motivo y queda el antes/después', () => {
  const base = { totpCode: '482913', reason: 'Cambio de banco pedido por la chica en persona' };

  it('2FA mala → 403 y no se cambia nada', async () => {
    const { svc, tx, audit } = setup({ stepUpFails: true });
    await expect(
      svc.update(actor, LUCIA, { ...base, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('dirección que no es del método → 400 sin escribir ni registrar', async () => {
    const { svc, tx, audit } = setup();
    await expect(
      svc.update(actor, LUCIA, { ...base, payoutMethod: 'USDT_TRC20', payoutAddress: EVM }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('IBAN válido: se guarda normalizado y cifrado, la respuesta va tapada y queda el antes/después con el motivo', async () => {
    const { svc, tx, stepUp, audit } = setup();
    const res = await svc.update(actor, LUCIA, {
      ...base,
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: ' es91 2100 0418 4502 0005 1332 ',
      payoutLabel: 'CaixaBank',
      payoutMetadata: { accountHolder: 'Lucía Pérez' },
    });
    expect(stepUp.verify).toHaveBeenCalledWith(actor, '482913', 'payout_account.update');
    const call = tx.user.update.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
    expect(call).toMatchObject({
      where: { id: LUCIA },
      data: { payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', payoutLabel: 'CaixaBank', payoutHolderMasked: 'L••• P•••' },
    });
    expect(openPayoutValue(String(call.data.payoutAddress), { userId: LUCIA, field: 'address' })).toBe(IBAN);
    expect(JSON.stringify(call.data)).not.toContain(IBAN);
    // Tenía otra cuenta: 48 h sin pagarle a la nueva.
    expect(call.data.payoutHoldUntil).toBeInstanceOf(Date);
    expect(res).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', hasPayoutAccount: true });
    expect(res).not.toHaveProperty('payoutAddress');
    // Al registro de la consola va la de verdad: lo tapa SuperAdminAuditService (maskSensitive).
    expect(audit.write).toHaveBeenCalledWith(actor, {
      action: 'payout_account.updated',
      tenantId: BAMBU.id,
      targetType: 'User',
      targetId: LUCIA,
      before: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON, payoutLabel: null, payoutHolder: null },
      after: { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutLabel: 'CaixaBank', payoutHolder: 'L••• P•••' },
      reason: base.reason,
    });
  });

  it('cambiada: aviso al local (Incidencias y Telegram, «por OxioPay») y correo a ella, todo tapado', async () => {
    const { svc, plainAudit, email } = setup();
    await svc.update(actor, LUCIA, { ...base, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutMetadata: { accountHolder: 'Lucía Pérez' } });
    expect(plainAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'operator.payout_account_changed',
        tenantId: BAMBU.id,
        actorId: actor.id,
        targetId: LUCIA,
        payload: expect.objectContaining({ via: 'oxiopay', name: 'Lucía' }),
      }),
    );
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'lucía@salabambu.es' }));
    expect(JSON.stringify([plainAudit.log.mock.calls, email.send.mock.calls])).not.toContain(IBAN);
  });

  it('se guarda solo si la cuenta sigue como se leyó: si el dueño la cambió a la vez, 409 y ni registro ni aviso', async () => {
    const changedAt = new Date('2026-10-01T10:00:00Z');
    const { svc, tx, audit, plainAudit, email } = setup({
      found: account(LUCIA, 'Lucía', 'USDT_TRC20', TRON, { payoutAccountChangedAt: changedAt }),
    });
    const dto = { ...base, payoutMethod: 'SEPA_IBAN' as const, payoutAddress: IBAN, payoutMetadata: { accountHolder: 'Lucía Pérez' } };
    await svc.update(actor, LUCIA, dto);
    expect(tx.user.update.mock.calls[0]![0]).toMatchObject({ where: { id: LUCIA, payoutAccountChangedAt: changedAt } });

    // El dueño la cambió entre leerla y guardarla: la fila ya no está «como se leyó» (P2025).
    vi.clearAllMocks();
    tx.user.update.mockRejectedValueOnce(Object.assign(new Error('Record to update not found'), { code: 'P2025' }));
    const err = await svc.update(actor, LUCIA, dto).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/acaba de cambiar por otro lado/);
    expect(audit.write).not.toHaveBeenCalled();
    expect(plainAudit.log).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('IBAN SEPA sin titular → 400 sin escribir', async () => {
    const { svc, tx } = setup();
    await expect(svc.update(actor, LUCIA, { ...base, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('quitar la cuenta (método y dirección a null) y los datos del banco (DbNull)', async () => {
    const wire = account(LUCIA, 'Lucía', 'WIRE_INTERNATIONAL', 'GE29NB0000000101904917', {
      payoutMetadata: { bankName: 'TBC Bank', swiftBic: 'TBCBGE22', accountHolder: 'Lucía Pérez' },
    });
    const { svc, tx } = setup({ found: wire });
    const res = await svc.update(actor, LUCIA, { ...base, payoutMethod: null, payoutAddress: null, payoutMetadata: null });
    expect(tx.user.update.mock.calls[0]![0].data).toMatchObject({
      payoutMethod: null,
      payoutAddress: null,
      payoutAddressMasked: null,
      payoutHoldUntil: null,
      payoutMetadata: Prisma.DbNull,
      payoutHolderMasked: null,
    });
    expect(res).toMatchObject({ payoutMethod: null, payoutAddressMasked: null, hasPayoutAccount: false });
  });

  it('no es una chica (o no existe) → 404 sin escribir', async () => {
    const { svc, tx } = setup({ found: null });
    await expect(
      svc.update(actor, LUCIA, { ...base, payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
