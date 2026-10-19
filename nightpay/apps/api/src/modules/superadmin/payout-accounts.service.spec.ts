import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { SuperAdminPayoutAccountsService } from './payout-accounts.service';

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
  const svc = new SuperAdminPayoutAccountsService(prisma as never, stepUp as never, audit as never);
  return { svc, tx, stepUp, audit };
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

  it('IBAN válido: se guarda normalizado, la respuesta va tapada y queda el antes/después con el motivo', async () => {
    const { svc, tx, stepUp, audit } = setup();
    const res = await svc.update(actor, LUCIA, {
      ...base,
      payoutMethod: 'SEPA_IBAN',
      payoutAddress: ' es91 2100 0418 4502 0005 1332 ',
      payoutLabel: 'CaixaBank',
    });
    expect(stepUp.verify).toHaveBeenCalledWith(actor, '482913', 'payout_account.update');
    expect(tx.user.update.mock.calls[0]![0]).toMatchObject({
      where: { id: LUCIA },
      data: { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutLabel: 'CaixaBank' },
    });
    expect(res).toMatchObject({ payoutMethod: 'SEPA_IBAN', payoutAddressMasked: 'ES91 •••• •••• 1332', hasPayoutAccount: true });
    expect(res).not.toHaveProperty('payoutAddress');
    expect(audit.write).toHaveBeenCalledWith(actor, {
      action: 'payout_account.updated',
      tenantId: BAMBU.id,
      targetType: 'User',
      targetId: LUCIA,
      before: { payoutMethod: 'USDT_TRC20', payoutAddress: TRON, payoutLabel: null },
      after: { payoutMethod: 'SEPA_IBAN', payoutAddress: IBAN, payoutLabel: 'CaixaBank' },
      reason: base.reason,
    });
  });

  it('quitar la cuenta (método y dirección a null) y los metadatos (DbNull)', async () => {
    const { svc, tx } = setup();
    const res = await svc.update(actor, LUCIA, { ...base, payoutMethod: null, payoutAddress: null, payoutMetadata: null });
    expect(tx.user.update.mock.calls[0]![0].data).toEqual({
      payoutMethod: null,
      payoutAddress: null,
      payoutMetadata: Prisma.DbNull,
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
