import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { PeanpeAdapter, peanpeCantidad } from './peanpe.adapter';

const API_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/** peanpe_calls tiene FORCE RLS: el adapter la usa dentro de withTenant / asSystem (aquí, el propio mock). */
function inTx<T extends object>(prisma: T): T {
  return Object.assign(prisma, {
    withTenant: (_tenantId: string, fn: (tx: T) => unknown) => fn(prisma),
    asSystem: (fn: (tx: T) => unknown) => fn(prisma),
  });
}
const ACCOUNT_ID = '91816';

function makeAdapter(prismaOverrides: Record<string, unknown> = {}) {
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      if (key === 'PEANPE_API_KEY') return API_KEY_HEX;
      if (key === 'PEANPE_ACCOUNT_ID') return ACCOUNT_ID;
      if (key === 'PEANPE_API_BASE_URL') return 'http://test.peanpe.com';
      return undefined;
    }),
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      if (key === 'PEANPE_API_KEY') return API_KEY_HEX;
      if (key === 'PEANPE_ACCOUNT_ID') return ACCOUNT_ID;
      throw new Error(`unknown config key: ${key}`);
    }),
  };
  const metrics = {
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  const prisma = {
    peanpeCall: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
      update: vi.fn().mockResolvedValue({}),
    },
    ...prismaOverrides,
  };
  return { adapter: new PeanpeAdapter(config as any, metrics as any, inTx(prisma) as any), prisma };
}

describe('PeanpeAdapter.authorize', () => {
  it('genera identificador_llamada de 6 chars y persiste mapping', async () => {
    const { adapter, prisma } = makeAdapter();
    const res = await adapter.authorize({
      tenantId: 'venue-1',
      paymentId: 'payment-uuid-1',
      amountCents: 5000,
      currency: 'EUR',
      terminalExternalId: 'BARRA-1',
      reference: 'payment-uuid-1',
    });
    expect(res.provider).toBe('PEANPE');
    expect(res.providerTxId).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.status).toBe('PROCESSING');
    expect((prisma as any).peanpeCall.create).toHaveBeenCalledOnce();
    const callArgs =
      ((prisma as any).peanpeCall.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.data.paymentId).toBe('payment-uuid-1');
    expect(callArgs.data.amountCents).toBe(5000);
    expect(callArgs.data.securityToken).toMatch(/^\d{10}$/);
  });

  it('C1: devuelve paymentLinkUrl con la URL hosted Peanpe firmada', async () => {
    const { adapter } = makeAdapter();
    const res = await adapter.authorize({
      tenantId: 'venue-1',
      paymentId: 'payment-uuid-1',
      amountCents: 5000,
      currency: 'EUR',
      terminalExternalId: 'BARRA-1',
      reference: 'payment-uuid-1',
    });
    expect(res.paymentLinkUrl).toBeDefined();
    expect(res.paymentLinkUrl).toMatch(/^http:\/\/test\.peanpe\.com\/api\?/);
    const params = new URL(res.paymentLinkUrl!).searchParams;
    expect(params.get('accion')).toBe('pagar');
    expect(params.get('identificador_llamada')).toBe(res.providerTxId);
    expect(params.get('cantidad')).toBe('5000');
    expect(params.get('firma')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lanza si PEANPE_API_KEY no configurado', async () => {
    const config = { get: vi.fn().mockReturnValue(undefined), getOrThrow: vi.fn() };
    const metrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
    const prisma = { peanpeCall: { findUnique: vi.fn(), create: vi.fn() } };
    const adapter = new PeanpeAdapter(config as any, metrics as any, inTx(prisma) as any);
    await expect(
      adapter.authorize({
        tenantId: 'v', paymentId: 'p', amountCents: 100,
        currency: 'EUR', terminalExternalId: '', reference: 'p',
      }),
    ).rejects.toThrow(/no configurado/);
  });

  it('H1 safety guard: BLOQUEA cobros >=50000c sin PEANPE_AMOUNT_FORMAT_VERIFIED', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.authorize({
        tenantId: 'venue-1',
        paymentId: 'payment-uuid-big',
        amountCents: 50_000, // 500€
        currency: 'EUR',
        terminalExternalId: '',
        reference: 'r',
      }),
    ).rejects.toThrow(/peanpe-amount-format-unverified/);
  });

  it('H1 safety guard: PERMITE cobros >=50000c si PEANPE_AMOUNT_FORMAT_VERIFIED=cents', async () => {
    const config = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
        if (key === 'PEANPE_API_KEY') return '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
        if (key === 'PEANPE_ACCOUNT_ID') return '91816';
        if (key === 'PEANPE_API_BASE_URL') return 'http://test.peanpe.com';
        if (key === 'PEANPE_AMOUNT_FORMAT_VERIFIED') return 'cents';
        return undefined;
      }),
      getOrThrow: vi.fn().mockImplementation((key: string) => {
        if (key === 'PEANPE_API_KEY') return '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
        if (key === 'PEANPE_ACCOUNT_ID') return '91816';
        throw new Error(`unknown config key: ${key}`);
      }),
    };
    const metrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
    const prisma = {
      peanpeCall: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => data),
        update: vi.fn(),
      },
    };
    const adapter = new PeanpeAdapter(config as any, metrics as any, inTx(prisma) as any);
    const res = await adapter.authorize({
      tenantId: 'v', paymentId: 'p', amountCents: 100_000,
      currency: 'EUR', terminalExternalId: '', reference: 'p',
    });
    expect(res.providerTxId).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('M2: P2002 collision retry — reintenta hasta encontrar id_llamada libre', async () => {
    let attempts = 0;
    const prismaWithCollision = {
      peanpeCall: {
        findUnique: vi.fn(),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          attempts += 1;
          if (attempts < 3) {
            // Simula Prisma P2002 unique violation
            const err = new Error('unique constraint') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          return data;
        }),
        update: vi.fn(),
      },
    };
    const { adapter } = makeAdapter(prismaWithCollision);
    const res = await adapter.authorize({
      tenantId: 'v', paymentId: 'p', amountCents: 100,
      currency: 'EUR', terminalExternalId: '', reference: 'p',
    });
    expect(res.providerTxId).toMatch(/^[A-Z0-9]{6}$/);
    expect(attempts).toBe(3);
  });

  it('M2: propaga errores que NO sean P2002 sin retry', async () => {
    const prismaWithError = {
      peanpeCall: {
        findUnique: vi.fn(),
        create: vi.fn().mockRejectedValue(new Error('DB down')),
        update: vi.fn(),
      },
    };
    const { adapter } = makeAdapter(prismaWithError);
    await expect(
      adapter.authorize({
        tenantId: 'v', paymentId: 'p', amountCents: 100,
        currency: 'EUR', terminalExternalId: '', reference: 'p',
      }),
    ).rejects.toThrow(/DB down/);
  });
});

describe('PeanpeAdapter.getStatus', () => {
  it('siempre UNKNOWN (Peanpe no expone status por API)', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.getStatus('v1', 'ABCDEF')).toBe('UNKNOWN');
  });
});

describe('PeanpeAdapter.refund', () => {
  it('lanza con mensaje claro (Peanpe NO soporta refund API)', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.refund({
        tenantId: 'v', paymentId: 'p', providerTxId: 'ABCDEF',
        amountCents: 1000, reference: 'r',
      }),
    ).rejects.toThrow(/peanpe-refund-manual-required/);
  });
});

describe('PeanpeAdapter.buildPaymentUrl', () => {
  it('construye URL con firma HMAC (apikey hex→bytes) según doc', () => {
    const { adapter } = makeAdapter();
    const url = adapter.buildPaymentUrl({
      identificadorLlamada: 'ABC123',
      amountCents: 5000,
      concepto: 'NightPay test',
      debug: true,
    });
    expect(url).toMatch(/^http:\/\/test\.peanpe\.com\/api\?/);
    const params = new URL(url).searchParams;
    expect(params.get('accion')).toBe('pagar');
    expect(params.get('identificador_cuenta_peanpe')).toBe(ACCOUNT_ID);
    expect(params.get('identificador_llamada')).toBe('ABC123');
    expect(params.get('cantidad')).toBe('5000');
    expect(params.get('debug')).toBe('1');
    // Firma según doc Peanpe: HMAC-SHA256 con apikey hex→bytes raw
    const expectedFirma = createHmac('sha256', Buffer.from(API_KEY_HEX, 'hex'))
      .update('ABC123' + ACCOUNT_ID + '5000')
      .digest('hex');
    expect(params.get('firma')).toBe(expectedFirma);
  });
});

describe('PeanpeAdapter.verifyWebhook', () => {
  it('valida payload con identificador_llamada + seguridad + status', () => {
    const { adapter } = makeAdapter();
    const body = JSON.stringify({
      identificador_llamada: 'ABC123',
      seguridad: '1234567890',
      status: '200',
      msg: 'correcto',
      accion: 'pagar',
      _paymentId: 'payment-uuid-1',
    });
    const res = adapter.verifyWebhook({}, Buffer.from(body, 'utf8'));
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.externalEventId).toBe('ABC123_pagar_200');
      expect(res.paymentRef).toBe('ABC123');
    }
  });

  it('rechaza payload sin status', () => {
    const { adapter } = makeAdapter();
    const body = JSON.stringify({ identificador_llamada: 'ABC123', seguridad: '0' });
    const res = adapter.verifyWebhook({}, Buffer.from(body, 'utf8'));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('missing-required-params');
  });

  it('rechaza JSON inválido', () => {
    const { adapter } = makeAdapter();
    const res = adapter.verifyWebhook({}, Buffer.from('not json', 'utf8'));
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('invalid-json');
  });
});

describe('PeanpeAdapter.mapWebhookToFsmEvent', () => {
  it('AUTHORIZED cuando status=200', () => {
    const { adapter } = makeAdapter();
    const evt = adapter.mapWebhookToFsmEvent({
      identificador_llamada: 'ABC123',
      status: '200',
      msg: 'correcto',
      accion: 'pagar',
      _paymentId: 'payment-uuid-1',
    });
    expect(evt).not.toBeNull();
    expect(evt!.paymentId).toBe('payment-uuid-1');
    expect(evt!.event.type).toBe('AUTHORIZED');
    if (evt!.event.type === 'AUTHORIZED') {
      expect(evt!.event.provider).toBe('PEANPE');
    }
  });

  it('status != 200 → null: una denegación no cierra el cobro (el cliente puede reintentar)', () => {
    const { adapter } = makeAdapter();
    const evt = adapter.mapWebhookToFsmEvent({
      identificador_llamada: 'ABC123',
      status: '101',
      msg: 'Card Error',
      _paymentId: 'payment-uuid-1',
    });
    expect(evt).toBeNull();
  });

  it('sin identificador_llamada → null (nunca un pedido vacío)', () => {
    const { adapter } = makeAdapter();
    expect(adapter.mapWebhookToFsmEvent({ status: '200', _paymentId: 'payment-uuid-1' })).toBeNull();
  });

  it('null sin _paymentId resuelto', () => {
    const { adapter } = makeAdapter();
    const evt = adapter.mapWebhookToFsmEvent({
      identificador_llamada: 'ABC123',
      status: '200',
    });
    expect(evt).toBeNull();
  });
});

describe('PeanpeAdapter — helpers para webhook controller', () => {
  it('getSecurityTokenForCall devuelve el token si existe', async () => {
    const { adapter, prisma } = makeAdapter({
      peanpeCall: {
        findUnique: vi.fn().mockResolvedValue({ securityToken: '9876543210' }),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const token = await adapter.getSecurityTokenForCall('ABC123');
    expect(token).toBe('9876543210');
    expect((prisma as any).peanpeCall.findUnique).toHaveBeenCalledWith({
      where: { identificadorLlamada: 'ABC123' },
      select: { securityToken: true },
    });
  });

  it('getSecurityTokenForCall devuelve null si no existe', async () => {
    const { adapter } = makeAdapter();
    const token = await adapter.getSecurityTokenForCall('UNKNOWN');
    expect(token).toBeNull();
  });

  it('resolvePaymentFromCallback valida security match', async () => {
    const { adapter } = makeAdapter({
      peanpeCall: {
        findUnique: vi.fn().mockResolvedValue({
          paymentId: 'payment-1',
          tenantId: 'venue-1',
          securityToken: '1234567890',
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const ok = await adapter.resolvePaymentFromCallback({
      identificadorLlamada: 'ABC123',
      seguridad: '1234567890',
    });
    expect(ok).toEqual({ paymentId: 'payment-1', tenantId: 'venue-1' });

    const fail = await adapter.resolvePaymentFromCallback({
      identificadorLlamada: 'ABC123',
      seguridad: '0000000000',
    });
    expect(fail).toBeNull();
  });
});

describe('PeanpeAdapter.proveApproval — el aviso de Peanpe no prueba nada (#1)', () => {
  it('siempre unverifiable: el cobro nunca se da por pagado solo con el aviso', async () => {
    const { adapter } = makeAdapter();
    expect(
      await adapter.proveApproval({
        paymentId: 'payment-uuid-1',
        providerTxId: 'ABC123',
        payload: { identificador_llamada: 'ABC123', status: '200', seguridad: '1234567890' },
      }),
    ).toEqual({ kind: 'unverifiable', reason: 'peanpe-sin-consulta' });
  });
});

describe('Peanpe en euros enteros (#55)', () => {
  function eurosAdapter() {
    const config = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
        if (key === 'PEANPE_API_KEY') return API_KEY_HEX;
        if (key === 'PEANPE_ACCOUNT_ID') return ACCOUNT_ID;
        if (key === 'PEANPE_API_BASE_URL') return 'http://test.peanpe.com';
        if (key === 'PEANPE_AMOUNT_FORMAT_VERIFIED') return 'euros';
        return undefined;
      }),
      getOrThrow: vi.fn().mockImplementation((key: string) => {
        if (key === 'PEANPE_API_KEY') return API_KEY_HEX;
        if (key === 'PEANPE_ACCOUNT_ID') return ACCOUNT_ID;
        throw new Error(`unknown config key: ${key}`);
      }),
    };
    const metrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
    const prisma = { peanpeCall: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } };
    return { adapter: new PeanpeAdapter(config as any, metrics as any, inTx(prisma) as any), prisma };
  }

  it('peanpeCantidad: céntimos tal cual; euros enteros divididos; con céntimos → error claro', () => {
    expect(peanpeCantidad(1250, 'cents')).toBe('1250');
    expect(peanpeCantidad(1200, 'euros')).toBe('12');
    expect(() => peanpeCantidad(1250, 'euros')).toThrow(/no puede cobrar 12,50 €/);
  });

  it('12,50 € en modo euros: no se redondea a 13 € — se rechaza antes de crear nada', async () => {
    const { adapter, prisma } = eurosAdapter();
    await expect(
      adapter.authorize({
        tenantId: 'v', paymentId: 'p', amountCents: 1250,
        currency: 'EUR', terminalExternalId: '', reference: 'p',
      }),
    ).rejects.toThrow(/peanpe-solo-euros-enteros/);
    expect(prisma.peanpeCall.create).not.toHaveBeenCalled();
    expect(() =>
      adapter.buildPaymentUrl({ identificadorLlamada: 'ABC123', amountCents: 1250, concepto: 'x' }),
    ).toThrow(/euros enteros/);
  });

  it('importe en euros enteros: cantidad sin céntimos', () => {
    const { adapter } = eurosAdapter();
    const url = adapter.buildPaymentUrl({ identificadorLlamada: 'ABC123', amountCents: 1200, concepto: 'x' });
    expect(new URL(url).searchParams.get('cantidad')).toBe('12');
  });
});
