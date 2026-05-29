import { describe, it, expect, vi } from 'vitest';
import { PeanpeDebugController } from './peanpe-debug.controller';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';

interface MakeOpts {
  apiKey?: string;
  accountId?: string;
  format?: string;
  thankyou?: string;
  baseUrl?: string;
  apiBase?: string;
  nodeEnv?: string;
}

function makeController(opts: MakeOpts = {}) {
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'PEANPE_API_KEY')
        return opts.apiKey ?? '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
      if (key === 'PEANPE_ACCOUNT_ID') return opts.accountId ?? '91816';
      if (key === 'PEANPE_API_BASE_URL') return opts.baseUrl ?? 'http://test.peanpe.com';
      if (key === 'PEANPE_THANKYOU_URL') return opts.thankyou ?? 'https://api.example.com/pay/result';
      if (key === 'PEANPE_AMOUNT_FORMAT_VERIFIED') return opts.format;
      if (key === 'NEXT_PUBLIC_API_URL') return opts.apiBase ?? 'https://api.paytomaxx.com';
      if (key === 'NODE_ENV') return opts.nodeEnv ?? 'test';
      return undefined;
    }),
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      if (key === 'PEANPE_API_KEY')
        return opts.apiKey ?? '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
      if (key === 'PEANPE_ACCOUNT_ID') return opts.accountId ?? '91816';
      throw new Error(`unknown ${key}`);
    }),
  };

  // PeanpeAdapter real — buildPaymentUrl es lo único usado por el debug;
  // lo invocamos de verdad para verificar firma e integración.
  const metrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
  const prisma = {
    peanpeCall: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peanpe = new PeanpeAdapter(config as any, metrics as any, prisma as any);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { controller: new PeanpeDebugController(config as any, peanpe), config };
}

describe('PeanpeDebugController.keycheck', () => {
  it('reporta apikey hex válida (64 chars)', () => {
    const { controller } = makeController();
    const res = controller.keycheck();
    expect(res.apiKeyPresent).toBe(true);
    expect(res.apiKeyLength).toBe(64);
    expect(res.apiKeyLooksHex).toBe(true);
    expect(res.accountId).toBe('91816');
    expect(res.webhookUrlExpected).toBe('https://api.paytomaxx.com/v1/webhooks/peanpe/notify');
  });

  it('safetyGuardActive=true cuando format unset + warning visible (obs #2)', () => {
    const { controller } = makeController({ format: undefined });
    const res = controller.keycheck();
    expect(res.amountFormatVerified).toBeNull();
    expect(res.safetyGuardActive).toBe(true);
    expect(res.warningIfUnverified).toMatch(/×100|x100|cobros <€500/i);
  });

  it('safetyGuardActive=false cuando format=cents + sin warning', () => {
    const { controller } = makeController({ format: 'cents' });
    const res = controller.keycheck();
    expect(res.amountFormatVerified).toBe('cents');
    expect(res.safetyGuardActive).toBe(false);
    expect(res.warningIfUnverified).toBeNull();
  });

  it('safetyGuardActive=false cuando format=euros + sin warning', () => {
    const { controller } = makeController({ format: 'euros' });
    const res = controller.keycheck();
    expect(res.amountFormatVerified).toBe('euros');
    expect(res.safetyGuardActive).toBe(false);
    expect(res.warningIfUnverified).toBeNull();
  });

  it('format=invalido se reporta como null (no permite valores arbitrarios)', () => {
    const { controller } = makeController({ format: 'cents_or_euros' });
    const res = controller.keycheck();
    expect(res.amountFormatVerified).toBeNull();
    expect(res.safetyGuardActive).toBe(true);
  });

  it('apikey con longitud != 64 se reporta apiKeyLooksHex=false', () => {
    const { controller } = makeController({ apiKey: '00112233' });
    const res = controller.keycheck();
    expect(res.apiKeyLength).toBe(8);
    expect(res.apiKeyLooksHex).toBe(false);
  });

  it('apikey con chars no-hex se reporta apiKeyLooksHex=false', () => {
    const { controller } = makeController({
      apiKey: 'ZZZ12233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    });
    const res = controller.keycheck();
    expect(res.apiKeyLooksHex).toBe(false);
  });
});

describe('PeanpeDebugController.dryRun (obs #5 reuses buildPaymentUrl)', () => {
  it('format=cents devuelve cantidad literal en céntimos', () => {
    const { controller } = makeController();
    const res = controller.dryRun('100', 'cents');
    expect(res.format).toBe('cents');
    expect(res.amountInputCents).toBe(100);
    expect(res.cantidadSentToPeanpe).toBe('100');
    expect(res.expectedChargeEUR).toBe(1);
    expect(res.url).toMatch(/identificador_llamada=DRY/);
    expect(res.url).toMatch(/cantidad=100/);
    expect(res.url).toMatch(/firma=[0-9a-f]{64}/);
    expect(res.url).toMatch(/debug=1/);
  });

  it('format=euros divide /100 antes de mandar', () => {
    const { controller } = makeController();
    const res = controller.dryRun('500', 'euros');
    expect(res.format).toBe('euros');
    expect(res.amountInputCents).toBe(500);
    expect(res.cantidadSentToPeanpe).toBe('5');
    expect(res.url).toMatch(/cantidad=5(&|$)/);
  });

  it('amount clamp 1..99999 (obs #1)', () => {
    const { controller } = makeController();
    const tooHigh = controller.dryRun('500000', 'cents');
    expect(tooHigh.amountInputCents).toBe(99_999);
    const tooLow = controller.dryRun('0', 'cents');
    expect(tooLow.amountInputCents).toBe(1);
    const negative = controller.dryRun('-50', 'cents');
    expect(negative.amountInputCents).toBe(1);
  });

  it('format desconocido defaultea a cents', () => {
    const { controller } = makeController();
    const res = controller.dryRun('100', 'bitcoin');
    expect(res.format).toBe('cents');
  });

  it('amount NaN defaultea a 100c (1€)', () => {
    const { controller } = makeController();
    const res = controller.dryRun('not-a-number', 'cents');
    expect(res.amountInputCents).toBe(1); // 0|0 → 1 tras max(1, ...)
  });

  it('dryId siempre empieza con DRY (no se confunde con id_llamada real)', () => {
    const { controller } = makeController();
    const res = controller.dryRun('100', 'cents');
    const match = res.url.match(/identificador_llamada=(DRY[A-Z0-9]+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^DRY[A-Z0-9]{3}$/);
  });

  it('instructions menciona el clamp 99999c (obs #1)', () => {
    const { controller } = makeController();
    const res = controller.dryRun('100', 'cents');
    expect(res.instructions.some((i) => /99_?999/.test(i))).toBe(true);
  });
});

describe('PeanpeDebugController audit (obs #9)', () => {
  it('en producción loggea WARN al hacer hit', () => {
    const { controller } = makeController({ nodeEnv: 'production' });
    const spy = vi.spyOn(
      (controller as unknown as { logger: { warn: (msg: string) => void } }).logger,
      'warn',
    );
    controller.keycheck();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[AUDIT]'));
  });

  it('en dev/test NO loggea (evita ruido en CI)', () => {
    const { controller } = makeController({ nodeEnv: 'test' });
    const spy = vi.spyOn(
      (controller as unknown as { logger: { warn: (msg: string) => void } }).logger,
      'warn',
    );
    controller.keycheck();
    expect(spy).not.toHaveBeenCalled();
  });
});
