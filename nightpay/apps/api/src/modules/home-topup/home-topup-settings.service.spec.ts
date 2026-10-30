import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@nightpay/db';
import { HOME_TOPUP_CODE_RE } from '@nightpay/contracts';
import { HomeTopUpSettingsService } from './home-topup-settings.service';

const VENUE = '11111111-1111-4111-8111-111111111111';
const OWNER = { userId: 'u-owner', email: 'duena@sala.test', tenantId: VENUE };

function make(o: { enabled?: boolean; code?: string | null; clashes?: number; problem?: boolean; fee?: boolean } = {}) {
  const row = { homeTopUpEnabled: o.enabled ?? false, homeTopUpCode: o.code === undefined ? null : o.code };
  let clashes = o.clashes ?? 0;
  const tx = {
    venue: {
      findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      update: vi.fn(async (args: { data: { homeTopUpCode?: string; homeTopUpEnabled?: boolean } }) => {
        if (args.data.homeTopUpCode && clashes > 0) {
          clashes -= 1;
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }
        Object.assign(row, args.data);
        return { id: VENUE };
      }),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async () => undefined) };
  const state = {
    state: { paused: false, card: o.problem ? false : true, wallet: true, hasGateway: true, hasTerminal: true },
    serviceFee: { enabled: o.fee ?? false, cardBps: 1000, topUpBps: 1200 },
  };
  const homeTopUps = { venueState: vi.fn(async () => state) };
  const config = { get: vi.fn((k: string) => (k === 'NEXT_PUBLIC_API_URL' ? 'https://api.sala.test/v1' : undefined)) };
  const service = new HomeTopUpSettingsService(prisma as never, audit as never, homeTopUps as never, config as never);
  return { service, row, tx, audit };
}

describe('Ajustes → «Cargar saldo desde casa»', () => {
  it('apagado de serie: sin enlace ni QR', async () => {
    const view = await make().service.view(VENUE);
    expect(view).toMatchObject({ enabled: false, url: null, qrPngDataUrl: null, problem: null, minCents: 1000, maxCents: 30000 });
  });

  it('al encender por primera vez se crea el código (al azar) y sale el enlace del API con su QR', async () => {
    const m = make();
    const view = await m.service.setEnabled(OWNER, true);
    expect(m.row.homeTopUpCode).toMatch(HOME_TOPUP_CODE_RE);
    expect(view.enabled).toBe(true);
    expect(view.url).toBe(`https://api.sala.test/r/${m.row.homeTopUpCode}`);
    expect(view.qrPngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(m.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue.home_topup.updated', payload: { before: { enabled: false }, after: { enabled: true } } }),
    );
    // Nunca el código en el registro.
    expect(JSON.stringify(m.audit.log.mock.calls)).not.toContain(m.row.homeTopUpCode ?? '-');
  });

  it('apagar conserva el código: al volver a encender, el mismo enlace', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' });
    expect((await m.service.setEnabled(OWNER, false)).url).toBeNull();
    expect(m.row.homeTopUpCode).toBe('AbCdEfGhIjKlMnOp');
    expect((await m.service.setEnabled(OWNER, true)).url).toBe('https://api.sala.test/r/AbCdEfGhIjKlMnOp');
  });

  it('lo mismo otra vez no cambia nada ni deja registro', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp' });
    await m.service.setEnabled(OWNER, true);
    expect(m.tx.venue.update).not.toHaveBeenCalled();
    expect(m.audit.log).not.toHaveBeenCalled();
  });

  it('«Enlace nuevo»: otro código (el de antes deja de valer); si chocara con el de otro local, otro', async () => {
    const m = make({ enabled: true, code: 'AbCdEfGhIjKlMnOp', clashes: 2 });
    const view = await m.service.rotate(OWNER);
    expect(m.row.homeTopUpCode).not.toBe('AbCdEfGhIjKlMnOp');
    expect(m.row.homeTopUpCode).toMatch(HOME_TOPUP_CODE_RE);
    expect(view.url).toBe(`https://api.sala.test/r/${m.row.homeTopUpCode}`);
    expect(m.tx.venue.update).toHaveBeenCalledTimes(3);
    expect(m.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'venue.home_topup.link_rotated', payload: {} }));
  });

  it('encendido pero sin «QR con tarjeta»: lo dice; con la comisión de las recargas, su %', async () => {
    const view = await make({ enabled: true, code: 'AbCdEfGhIjKlMnOp', problem: true, fee: true }).service.view(VENUE);
    expect(view.problem).toBe('methods');
    expect(view.serviceFeeBps).toBe(1200);
  });
});
