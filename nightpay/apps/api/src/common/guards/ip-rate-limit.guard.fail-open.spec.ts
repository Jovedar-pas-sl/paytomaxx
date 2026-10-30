import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpException, Logger, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IP_LIMIT_FAIL_OPEN_TIMEOUT_MS,
  IP_RATE_LIMIT_META,
  IpRateLimit,
  IpRateLimitGuard,
  type IpRateLimitConfig,
} from './ip-rate-limit.guard';
import { PaymentsController } from '../../modules/payments/payments.controller';
import { PublicPayController } from '../../modules/payments/public-pay.controller';
import { PublicWalletController } from '../../modules/wallets/public-wallet.controller';
import { PublicSaldoController } from '../../modules/wallets/public-saldo.controller';
import { PublicWalletCardController } from '../../modules/wallets/public-wallet-card.controller';
import { PublicPayoutConfirmController } from '../../modules/wallets/public-payout-confirm.controller';
import { PublicWalletActivationController } from '../../modules/wallets/public-wallet-activation.controller';
import { AuthController } from '../../modules/auth/auth.controller';

/**
 * Sin Redis (reiniciándose unos segundos), las páginas y sondeos del cliente
 * no dan 500: su límite deja pasar (con aviso en el log). Lo que adivina un
 * secreto (login, PIN, códigos) sigue cerrado.
 */

const PAGE: IpRateLimitConfig = { max: 2, windowSec: 60, scope: 'pagina', failOpen: true };
const PIN: IpRateLimitConfig = { max: 2, windowSec: 60, scope: 'pin' };

class Dummy {
  @IpRateLimit(PAGE)
  pagina(): void {}

  @IpRateLimit(PIN)
  pin(): void {}
}

function ctx(method: keyof Dummy): ExecutionContext {
  const req = { headers: {}, socket: { remoteAddress: '83.45.120.7' } };
  return {
    getHandler: () => Dummy.prototype[method],
    getClass: () => Dummy,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: vi.fn() }) }),
  } as unknown as ExecutionContext;
}

function redisDown(incr: () => Promise<number>) {
  return { incr: vi.fn(incr), expire: vi.fn().mockResolvedValue(1), ttl: vi.fn().mockResolvedValue(60) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('IpRateLimitGuard sin Redis', () => {
  it('página del cliente (failOpen): Redis da error → pasa, con aviso en el log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const guard = new IpRateLimitGuard(new Reflector(), redisDown(() => Promise.reject(new Error('Connection is closed.'))) as never);
    await expect(guard.canActivate(ctx('pagina'))).resolves.toBe(true);
    expect(String(warn.mock.calls[0]?.[0])).toContain('sin Redis (scope=pagina): se deja pasar');
  });

  it('página del cliente (failOpen): Redis no contesta → pasa al cabo de un momento, sin quedarse colgada', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const guard = new IpRateLimitGuard(new Reflector(), redisDown(() => new Promise<number>(() => undefined)) as never);
    const pending = guard.canActivate(ctx('pagina'));
    await vi.advanceTimersByTimeAsync(IP_LIMIT_FAIL_OPEN_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBe(true);
  });

  it('con Redis bien, la página del cliente sigue teniendo su tope', async () => {
    const store = new Map<string, number>();
    const redis = {
      incr: vi.fn(async (k: string) => {
        store.set(k, (store.get(k) ?? 0) + 1);
        return store.get(k)!;
      }),
      expire: vi.fn().mockResolvedValue(1),
      ttl: vi.fn().mockResolvedValue(60),
    };
    const guard = new IpRateLimitGuard(new Reflector(), redis as never);
    await guard.canActivate(ctx('pagina'));
    await guard.canActivate(ctx('pagina'));
    await expect(guard.canActivate(ctx('pagina'))).rejects.toThrow(HttpException);
  });

  it('lo que adivina un secreto (PIN) sigue cerrado: sin Redis no pasa', async () => {
    const guard = new IpRateLimitGuard(new Reflector(), redisDown(() => Promise.reject(new Error('Connection is closed.'))) as never);
    await expect(guard.canActivate(ctx('pin'))).rejects.toThrow('Connection is closed.');
  });
});

describe('qué límites dejan pasar sin Redis (las rutas de verdad)', () => {
  const meta = (target: object, method: string) =>
    Reflect.getMetadata(IP_RATE_LIMIT_META, (target as Record<string, unknown>)[method] as object) as IpRateLimitConfig;

  it('las páginas y sondeos de lectura del cliente: sí', () => {
    const open: Array<[object, string]> = [
      [PaymentsController.prototype, 'getPublic'],
      [PublicPayController.prototype, 'paymentResult'],
      [PublicPayController.prototype, 'receipt'],
      [PublicPayController.prototype, 'checkout'],
      [PublicPayController.prototype, 'payPage'],
      [PublicWalletController.prototype, 'page'],
      [PublicWalletController.prototype, 'state'],
      [PublicSaldoController.prototype, 'page'],
      [PublicSaldoController.prototype, 'state'],
      [PublicWalletCardController.prototype, 'page'],
      [PublicPayoutConfirmController.prototype, 'page'],
      [PublicWalletActivationController.prototype, 'page'],
    ];
    for (const [target, method] of open) expect({ method, failOpen: meta(target, method).failOpen }).toEqual({ method, failOpen: true });
  });

  it('login, PIN, llaves y códigos: no', () => {
    const closed: Array<[object, string]> = [
      [AuthController.prototype, 'login'],
      [PublicPayController.prototype, 'walletPin'],
      [PublicWalletController.prototype, 'pin'],
      [PublicSaldoController.prototype, 'pay'],
      // El QR de activación (M-2): registrar el primer Face ID o PIN, nunca sin límite.
      [PublicWalletActivationController.prototype, 'passkeyOptions'],
      [PublicWalletActivationController.prototype, 'passkey'],
      [PublicWalletActivationController.prototype, 'pin'],
    ];
    for (const [target, method] of closed) expect({ method, failOpen: meta(target, method).failOpen }).toEqual({ method, failOpen: undefined });
  });
});
