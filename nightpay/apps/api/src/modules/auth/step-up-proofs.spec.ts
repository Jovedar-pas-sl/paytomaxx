import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import { ClsService } from 'nestjs-cls';
import { PASSKEY_REQUIRED_CODE, stepUpActions } from '@nightpay/contracts';
import { assertTwoFactorCode } from '../wallets/wallet-two-factor';
import { createFakeRedis } from './testing/fake-redis';
import { StepUpService } from './step-up.service';
import { StepUpTokens } from './step-up-tokens';
import { totpForbidden } from './totp-code';
import { TotpService } from './totp.service';

const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const SID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-08T00:20:00.000Z');
const REFUND = stepUpActions.refund('7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', 12_000);
const OTHER = stepUpActions.refund('7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b', 99_000);

function totpSetup(o: { secret?: string | null; passkeys?: number } = {}) {
  const redis = createFakeRedis();
  const tokens = new StepUpTokens(redis as never);
  const cls = new ClsService(new AsyncLocalStorage());
  const prisma = {
    acrossVenues: async (fn: (tx: unknown) => unknown) => fn({ user: { findUnique: async () => ({ totpSecret: o.secret ?? null }) } }),
    staffPasskey: { count: vi.fn(async () => o.passkeys ?? 1) },
  };
  const attempts = { assertNotLocked: vi.fn(), claimStep: vi.fn(async () => true), clearFailures: vi.fn(), recordFailure: vi.fn(async () => false) };
  const totp = new TotpService(prisma as never, attempts as never, tokens, cls as never);
  /** Una petición de Lola en su sesión, con la cabecera X-Step-Up-Token. */
  const request = <T>(token: string | undefined, fn: () => Promise<T>) =>
    cls.run(async () => {
      cls.set('ctx', { userId: LOLA, sessionId: SID, ...(token ? { stepUpToken: token } : {}) });
      return fn();
    });
  return { totp, tokens, request };
}

describe('pruebas para actuar sin 2FA (con la llave de acceso)', () => {
  it('una prueba vale una vez, para su persona, su sesión y su acción', async () => {
    const tokens = new StepUpTokens(createFakeRedis() as never);
    const proof = await tokens.mint({ userId: LOLA, sessionId: SID, action: REFUND }, NOW);
    expect(proof).toMatchObject({ action: REFUND, expiresAt: '2026-11-08T00:22:00.000Z' });
    expect(await tokens.consume({ userId: LOLA, sessionId: SID, action: OTHER }, proof.token)).toBe(false);
    expect(await tokens.consume({ userId: 'otra', sessionId: SID, action: REFUND }, proof.token)).toBe(false);
    expect(await tokens.consume({ userId: LOLA, sessionId: 'otra-sesion', action: REFUND }, proof.token)).toBe(false);
    expect(await tokens.consume({ userId: LOLA, sessionId: SID, action: REFUND }, proof.token)).toBe(true);
    expect(await tokens.consume({ userId: LOLA, sessionId: SID, action: REFUND }, proof.token)).toBe(false);
    expect(await tokens.consume({ userId: LOLA, sessionId: SID, action: REFUND }, 'no-es-una-prueba')).toBe(false);
  });

  it('la acción que pide la 2FA la acepta de quien no la tiene; en la misma petición vale dos veces, en otra ya no', async () => {
    const { totp, tokens, request } = totpSetup();
    const proof = await tokens.mint({ userId: LOLA, sessionId: SID, action: REFUND });
    await request(proof.token, async () => {
      await expect(totp.assertForUser(LOLA, undefined, REFUND)).resolves.toBeUndefined();
      // Un reintento dentro de la misma petición (la misma acción): sin gastar otra.
      await expect(totp.assertForUser(LOLA, undefined, REFUND)).resolves.toBeUndefined();
    });
    await request(proof.token, async () => {
      await expect(totp.assertForUser(LOLA, undefined, REFUND)).rejects.toMatchObject({
        response: { code: PASSKEY_REQUIRED_CODE, stepUpAction: REFUND },
      });
    });
  });

  it('la prueba de otra acción no vale (y no se gasta)', async () => {
    const { totp, tokens, request } = totpSetup();
    const proof = await tokens.mint({ userId: LOLA, sessionId: SID, action: OTHER });
    await request(proof.token, () =>
      expect(totp.assertForUser(LOLA, undefined, REFUND)).rejects.toMatchObject({ response: { code: PASSKEY_REQUIRED_CODE } }),
    );
    await request(proof.token, () => expect(totp.assertForUser(LOLA, undefined, OTHER)).resolves.toBeUndefined());
  });

  it('sin llaves, como siempre: TOTP_NOT_ENROLLED; sin acción (login, cambio de local), la llave no cuenta', async () => {
    const { totp, request } = totpSetup({ passkeys: 0 });
    await request(undefined, () => expect(totp.assertForUser(LOLA, undefined, REFUND)).rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENROLLED' } }));
    const withKey = totpSetup();
    const proof = await withKey.tokens.mint({ userId: LOLA, sessionId: SID, action: REFUND });
    await withKey.request(proof.token, () =>
      expect(withKey.totp.assertForUser(LOLA, undefined)).rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENROLLED' } }),
    );
  });

  it('quien tiene 2FA sigue con su código: la prueba de una llave no la sustituye', async () => {
    const { totp, tokens, request } = totpSetup({ secret: 'JBSWY3DPEHPK3PXP' });
    const proof = await tokens.mint({ userId: LOLA, sessionId: SID, action: REFUND });
    await request(proof.token, () => expect(totp.assertForUser(LOLA, undefined, REFUND)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } }));
  });

  it('assertTwoFactorCode (anular, devolver en efectivo…): con la acción acepta la prueba; con llave y sin prueba, PASSKEY_REQUIRED con su texto', async () => {
    const { totp, tokens, request } = totpSetup();
    const action = stepUpActions.reverseConsumption('c-1');
    const proof = await tokens.mint({ userId: LOLA, sessionId: SID, action });
    await request(proof.token, () => expect(assertTwoFactorCode(totp, LOLA, undefined, 'Para anular 12,00 €:', action)).resolves.toBeUndefined());
    await request(undefined, () =>
      expect(assertTwoFactorCode(totp, LOLA, undefined, 'Para anular 12,00 €:', action)).rejects.toMatchObject({
        response: { code: PASSKEY_REQUIRED_CODE, stepUpAction: action, message: expect.stringMatching(/^Para anular 12,00 €: confirma con tu llave/) },
      }),
    );
    // Sin acción (quien llama no se ha pasado aún a la llave): como antes.
    await request(undefined, () =>
      expect(assertTwoFactorCode(totp, LOLA, undefined, 'Para anular 12,00 €:')).rejects.toMatchObject({ response: { code: 'TOTP_NOT_ENROLLED' } }),
    );
  });
});

describe('verificarse con la llave (StepUpService)', () => {
  function stepUpSetup(o: { totpEnabled?: boolean; verifyFails?: boolean } = {}) {
    const redis = createFakeRedis();
    const totp = {
      isEnabled: vi.fn(async () => o.totpEnabled ?? false),
      assertForUser: vi.fn(async () => {
        throw totpForbidden('notEnrolled');
      }),
    };
    const keys = {
      authenticationOptions: vi.fn(async () => ({ challenge: 'reto' })),
      verify: vi.fn(async () => {
        if (o.verifyFails) throw new Error('firma mala');
      }),
    };
    const audit = { log: vi.fn(async () => undefined) };
    const tokens = new StepUpTokens(redis as never);
    const svc = new StepUpService(redis as never, totp as never, audit as never, { count: async () => 1 }, keys as never, tokens);
    return { svc, keys, audit, tokens };
  }
  const me = { userId: LOLA, sessionId: SID };

  it('sin acción: 5 minutos para ver lo delicado', async () => {
    const { svc, keys } = stepUpSetup();
    const out = await svc.verifyWithPasskey(me, { id: 'x' }, undefined, 'https://operator.paytomaxx.com', NOW);
    expect(out).toMatchObject({ verifiedUntil: '2026-11-08T00:25:00.000Z', verifiedWith: 'passkey', method: 'passkey', proof: null });
    expect(keys.verify).toHaveBeenCalledWith(me, 'view', { id: 'x' }, 'https://operator.paytomaxx.com');
  });

  it('con acción: la prueba de esa acción (y no la verificación para ver)', async () => {
    const { svc, keys, tokens } = stepUpSetup();
    const out = await svc.verifyWithPasskey(me, { id: 'x' }, REFUND, undefined, NOW);
    expect(out.verifiedUntil).toBeNull();
    expect(out.proof).toMatchObject({ action: REFUND });
    expect(keys.verify).toHaveBeenCalledWith(me, `action:${REFUND}`, { id: 'x' }, undefined);
    expect(await tokens.consume({ userId: LOLA, sessionId: SID, action: REFUND }, out.proof!.token)).toBe(true);
  });

  it('quien tiene 2FA no puede usar la llave: 403 TOTP_REQUIRED', async () => {
    const { svc, keys } = stepUpSetup({ totpEnabled: true });
    await expect(svc.passkeyOptions(me, undefined, undefined)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    await expect(svc.verifyWithPasskey(me, {}, undefined, undefined, NOW)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect(keys.verify).not.toHaveBeenCalled();
  });

  it('una firma mala no verifica y queda en el registro', async () => {
    const { svc, audit } = stepUpSetup({ verifyFails: true });
    await expect(svc.verifyWithPasskey(me, {}, undefined, undefined, NOW)).rejects.toThrow('firma mala');
    expect(await svc.current(me, NOW)).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.step_up.failed', payload: { method: 'passkey' } }));
  });
});
