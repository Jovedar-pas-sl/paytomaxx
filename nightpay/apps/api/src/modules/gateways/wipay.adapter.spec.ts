import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WipayAdapter,
  cecabankCodeToCurrency,
  signRequest,
  signWebhook,
  numOperacionFromPaymentId,
  paymentIdFromNumOperacion,
  currencyToCecabankCode,
  parseFormUrlEncoded,
  wipayOutcome,
} from './wipay.adapter';

const MERCHANT_ID = '111950028';
const ACQUIRER_BIN = '0000554052';
const TERMINAL_ID = '00000003';
const CLAVE = '99888888';

function makeAdapter(opts?: { withCreds?: boolean; apiUrl?: string }) {
  const withCreds = opts?.withCreds ?? true;
  const apiUrl = opts?.apiUrl ?? 'https://tpv.ceca.es/tpvweb/tpv/compra.action';
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      if (key === 'WIPAY_API_URL') return apiUrl;
      if (key === 'NEXT_PUBLIC_API_URL') return 'https://api.paytomaxx.com';
      if (!withCreds) return undefined;
      if (key === 'WIPAY_MERCHANT_ID') return MERCHANT_ID;
      if (key === 'WIPAY_ACQUIRER_BIN') return ACQUIRER_BIN;
      if (key === 'WIPAY_TERMINAL_ID') return TERMINAL_ID;
      if (key === 'WIPAY_CLAVE_ENCRIPTACION') return CLAVE;
      return undefined;
    }),
    getOrThrow: vi.fn().mockImplementation((key: string) => {
      const v = config.get(key);
      if (v === undefined) throw new Error(`unknown config key: ${key}`);
      return v;
    }),
  };
  const metrics = {
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  return new WipayAdapter(config as any, metrics as any);
}

describe('signRequest — firma SHA-256 contra ejemplo del manual sección 5', () => {
  it('reproduce el resultado conocido del manual (cifrado=SHA2)', () => {
    // Ejemplo manual:
    //   Clave=99888888, MerchantID=111950028, AcquirerBIN=0000554052,
    //   TerminalID=00000003, Num_operacion=123, Importe=500, TipoMoneda=978,
    //   Exponente=2, Referencia=(vacío), Cifrado=SHA2,
    //   URL_OK=http://www.ceca.es, URL_NOK=http://www.ceca.es
    //   → firma 2b7f686593f1a424c510321e4bc354d21924e02e980a90f4d46c41f92a06f5a9
    const firma = signRequest({
      claveEncriptacion: '99888888',
      merchantId: '111950028',
      acquirerBin: '0000554052',
      terminalId: '00000003',
      numOperacion: '123',
      importe: '500',
      tipoMoneda: '978',
      exponente: '2',
      referencia: '',
      cifrado: 'SHA2',
      urlOk: 'http://www.ceca.es',
      urlNok: 'http://www.ceca.es',
    });
    expect(firma).toBe('2b7f686593f1a424c510321e4bc354d21924e02e980a90f4d46c41f92a06f5a9');
  });
});

describe('signWebhook — firma del callback Cecabank', () => {
  it('produce un hash hex de 64 chars determinístico', () => {
    const firma = signWebhook({
      claveEncriptacion: CLAVE,
      merchantId: MERCHANT_ID,
      acquirerBin: ACQUIRER_BIN,
      terminalId: TERMINAL_ID,
      numOperacion: 'op-1',
      importe: '100',
      tipoMoneda: '978',
      exponente: '2',
      referencia: '',
    });
    expect(firma).toMatch(/^[a-f0-9]{64}$/);

    // Re-firmar mismo input → mismo output
    const firma2 = signWebhook({
      claveEncriptacion: CLAVE,
      merchantId: MERCHANT_ID,
      acquirerBin: ACQUIRER_BIN,
      terminalId: TERMINAL_ID,
      numOperacion: 'op-1',
      importe: '100',
      tipoMoneda: '978',
      exponente: '2',
      referencia: '',
    });
    expect(firma).toBe(firma2);
  });

  it('cambia si cambia cualquier campo', () => {
    const a = signWebhook({
      claveEncriptacion: CLAVE,
      merchantId: MERCHANT_ID,
      acquirerBin: ACQUIRER_BIN,
      terminalId: TERMINAL_ID,
      numOperacion: 'op-1',
      importe: '100',
      tipoMoneda: '978',
      exponente: '2',
      referencia: '',
    });
    const b = signWebhook({
      claveEncriptacion: CLAVE,
      merchantId: MERCHANT_ID,
      acquirerBin: ACQUIRER_BIN,
      terminalId: TERMINAL_ID,
      numOperacion: 'op-1',
      importe: '200', // ← cambió importe
      tipoMoneda: '978',
      exponente: '2',
      referencia: '',
    });
    expect(a).not.toBe(b);
  });
});

describe('numOperacion <-> paymentId roundtrip', () => {
  it('genera Num_operacion <= 50 chars sin guiones', () => {
    const pid = 'aabbccdd-1122-3344-5566-778899aabbcc';
    const op = numOperacionFromPaymentId(pid);
    expect(op).toBe('aabbccdd112233445566778899aabbcc');
    expect(op.length).toBeLessThanOrEqual(50);
    expect(op.includes('-')).toBe(false);
  });

  it('reconstruye el UUID original a partir del Num_operacion', () => {
    const pid = 'aabbccdd-1122-3344-5566-778899aabbcc';
    const op = numOperacionFromPaymentId(pid);
    expect(paymentIdFromNumOperacion(op)).toBe(pid);
  });

  it('devuelve el string crudo si no parece UUID', () => {
    expect(paymentIdFromNumOperacion('not-a-hex')).toBe('not-a-hex');
  });
});

describe('currencyToCecabankCode', () => {
  it('EUR → 978', () => expect(currencyToCecabankCode('EUR')).toBe('978'));
  it('USD → 840', () => expect(currencyToCecabankCode('USD')).toBe('840'));
  it('GBP → 826', () => expect(currencyToCecabankCode('GBP')).toBe('826'));
  it('desconocida → fallback 978 (EUR)', () =>
    expect(currencyToCecabankCode('XXX')).toBe('978'));
});

describe('parseFormUrlEncoded', () => {
  it('parsea pares clave=valor separados por &', () => {
    expect(parseFormUrlEncoded('a=1&b=2&c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });
  it('decodifica URL-encoding', () => {
    expect(parseFormUrlEncoded('Descripcion=hola%20mundo')).toEqual({
      Descripcion: 'hola mundo',
    });
  });
  it('decodifica + como espacio', () => {
    expect(parseFormUrlEncoded('a=hola+mundo')).toEqual({ a: 'hola mundo' });
  });
  it('handle pair sin =', () => {
    expect(parseFormUrlEncoded('a&b=2')).toEqual({ a: '', b: '2' });
  });
});

describe('WipayAdapter authorize() — Cecabank flow', () => {
  it('devuelve checkoutForm con action + fields firmados', async () => {
    const adapter = makeAdapter();
    const result = await adapter.authorize({
      tenantId: '00000000-0000-0000-0000-000000000000',
      paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'aabbccdd-1122-3344-5566-778899aabbcc',
    });
    expect(result.provider).toBe('WIPAY');
    expect(result.status).toBe('PROCESSING');
    expect(result.checkoutForm).toBeDefined();
    expect(result.checkoutForm?.action).toBe('https://tpv.ceca.es/tpvweb/tpv/compra.action');
    expect(result.checkoutForm?.method).toBe('POST');

    const f = result.checkoutForm!.fields;
    expect(f.MerchantID).toBe(MERCHANT_ID);
    expect(f.AcquirerBIN).toBe(ACQUIRER_BIN);
    expect(f.TerminalID).toBe(TERMINAL_ID);
    expect(f.Importe).toBe('100');
    expect(f.TipoMoneda).toBe('978');
    expect(f.Exponente).toBe('2');
    expect(f.Cifrado).toBe('SHA2');
    expect(f.Pago_soportado).toBe('SSL');
    expect(f.Firma).toMatch(/^[a-f0-9]{64}$/);
    expect(f.URL_OK).toContain('/pay/result');
    expect(f.URL_NOK).toContain('status=ko');
  });

  it('lanza error si faltan credenciales', async () => {
    const adapter = makeAdapter({ withCreds: false });
    await expect(
      adapter.authorize({
        tenantId: '00000000-0000-0000-0000-000000000000',
        paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
        amountCents: 100,
        currency: 'EUR',
        terminalExternalId: '',
        reference: 'ref-1',
      }),
    ).rejects.toThrow(/credentials no configuradas/);
  });
});

describe('WipayAdapter.verifyWebhook — firma Cecabank', () => {
  let adapter: WipayAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  function buildWebhookBody(overrides: Partial<Record<string, string>> = {}): string {
    const fields: Record<string, string> = {
      MerchantID: MERCHANT_ID,
      AcquirerBIN: ACQUIRER_BIN,
      TerminalID: TERMINAL_ID,
      Num_operacion: 'op-test-1',
      Importe: '100',
      TipoMoneda: '978',
      Exponente: '2',
      Referencia: 'refX',
      Num_aut: '101010',
      ...overrides,
    };
    const firma = signWebhook({
      claveEncriptacion: CLAVE,
      merchantId: fields.MerchantID!,
      acquirerBin: fields.AcquirerBIN!,
      terminalId: fields.TerminalID!,
      numOperacion: fields.Num_operacion!,
      importe: fields.Importe!,
      tipoMoneda: fields.TipoMoneda!,
      exponente: fields.Exponente!,
      referencia: fields.Referencia!,
    });
    const all = { ...fields, Firma: firma };
    return Object.entries(all)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  it('acepta webhook con firma válida (form-urlencoded)', () => {
    const body = buildWebhookBody();
    const result = adapter.verifyWebhook({}, Buffer.from(body));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.externalEventId).toBe('op-test-1-approved');
      expect(result.paymentRef).toBe('op-test-1');
    }
  });

  it('una denegación y el OK posterior de la misma operación no se deduplican entre sí', () => {
    const ko = adapter.verifyWebhook({}, Buffer.from(buildWebhookBody({ Num_aut: '', COD_AUT: '190' })));
    const ok = adapter.verifyWebhook({}, Buffer.from(buildWebhookBody()));
    expect(ko.valid && ok.valid).toBe(true);
    expect(ko.externalEventId).toBe('op-test-1-denied');
    expect(ok.externalEventId).not.toBe(ko.externalEventId);
  });

  it('rechaza firma incorrecta', () => {
    const body = buildWebhookBody();
    const tampered = body.replace(/Firma=[a-f0-9]+/, 'Firma=00000000');
    const result = adapter.verifyWebhook({}, Buffer.from(tampered));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature-mismatch');
  });

  it('rechaza si MerchantID no coincide con nuestras creds', () => {
    const body = buildWebhookBody({ MerchantID: '999999999' });
    const result = adapter.verifyWebhook({}, Buffer.from(body));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('merchant-id-mismatch');
  });

  it('rechaza si faltan campos requeridos', () => {
    const result = adapter.verifyWebhook({}, Buffer.from('MerchantID=x'));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing-required-fields');
  });

  it('rechaza si las creds NO están configuradas (defensa)', () => {
    const adapter2 = makeAdapter({ withCreds: false });
    const body = buildWebhookBody();
    const result = adapter2.verifyWebhook({}, Buffer.from(body));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('creds-not-configured');
  });
});

describe('WipayAdapter.mapWebhookToFsmEvent — códigos Cecabank', () => {
  let adapter: WipayAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('Num_aut presente sin COD_AUT error → AUTHORIZED', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      Num_operacion: 'aabbccdd112233445566778899aabbcc',
      Num_aut: '101010',
    });
    expect(evt?.event.type).toBe('AUTHORIZED');
    if (evt?.event.type === 'AUTHORIZED') {
      // reconstruye UUID
      expect(evt.paymentId).toBe('aabbccdd-1122-3344-5566-778899aabbcc');
      expect(evt.event.provider).toBe('WIPAY');
    }
  });

  it('COD_AUT=190 (denegada) → null: no se cierra el cobro, el cliente puede reintentar (#5)', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      Num_operacion: 'op-x',
      COD_AUT: '190',
    });
    expect(evt).toBeNull();
  });

  it('COD_AUT=400 (anulación) → null: no es un cobro ni lo cierra', () => {
    const evt = adapter.mapWebhookToFsmEvent({
      Num_operacion: 'op-x',
      COD_AUT: '400',
    });
    expect(evt).toBeNull();
  });

  it('COD_AUT de error manda aunque venga también Num_aut', () => {
    expect(wipayOutcome({ Num_aut: '101010', COD_AUT: '190' })).toBe('denied');
    expect(wipayOutcome({ Num_aut: '101010', COD_AUT: '000' })).toBe('approved');
    expect(wipayOutcome({})).toBe('unknown');
  });

  it('sin Num_aut y sin COD_AUT → null (defensivo)', () => {
    const evt = adapter.mapWebhookToFsmEvent({ Num_operacion: 'op-x' });
    expect(evt).toBeNull();
  });

  it('sin Num_operacion → null', () => {
    const evt = adapter.mapWebhookToFsmEvent({ Num_aut: '101010' });
    expect(evt).toBeNull();
  });
});

describe('WipayAdapter.proveApproval — importe de la parte firmada (#51)', () => {
  const OP = 'aabbccdd112233445566778899aabbcc';
  function signedPayload(overrides: Record<string, string> = {}): Record<string, string> {
    const fields: Record<string, string> = {
      MerchantID: MERCHANT_ID,
      AcquirerBIN: ACQUIRER_BIN,
      TerminalID: TERMINAL_ID,
      Num_operacion: OP,
      Importe: '4850',
      TipoMoneda: '978',
      Exponente: '2',
      Referencia: 'ref1',
      Num_aut: '101010',
      ...overrides,
    };
    const Firma = signWebhook({
      claveEncriptacion: CLAVE,
      merchantId: fields.MerchantID!,
      acquirerBin: fields.AcquirerBIN!,
      terminalId: fields.TerminalID!,
      numOperacion: fields.Num_operacion!,
      importe: fields.Importe!,
      tipoMoneda: fields.TipoMoneda!,
      exponente: fields.Exponente!,
      referencia: fields.Referencia!,
    });
    return { ...fields, Firma };
  }
  const claim = (payload: Record<string, string>) => ({
    paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
    providerTxId: OP,
    payload,
  });

  it('firma buena → importe (céntimos) y moneda ISO del aviso firmado', async () => {
    expect(await makeAdapter().proveApproval(claim(signedPayload()))).toEqual({
      kind: 'confirmed',
      amountCents: 4850,
      currency: 'EUR',
    });
  });

  it('importe tocado después de firmar → rejected', async () => {
    const forged = { ...signedPayload(), Importe: '1' };
    expect(await makeAdapter().proveApproval(claim(forged))).toMatchObject({ kind: 'rejected' });
  });

  it('Num_aut no va en la firma: cambiarlo no cambia la prueba (ni se usa como autorización)', async () => {
    const other = { ...signedPayload(), Num_aut: '999999' };
    expect(await makeAdapter().proveApproval(claim(other))).toMatchObject({ kind: 'confirmed', amountCents: 4850 });
  });

  it('otra operación, otro exponente o sin credenciales → no se da por bueno', async () => {
    expect(await makeAdapter().proveApproval({ ...claim(signedPayload()), providerTxId: 'otra' })).toMatchObject({
      kind: 'rejected',
      reason: 'operacion-distinta',
    });
    expect(await makeAdapter().proveApproval(claim(signedPayload({ Exponente: '0' })))).toMatchObject({
      kind: 'rejected',
      reason: 'exponente-no-soportado',
    });
    expect(await makeAdapter({ withCreds: false }).proveApproval(claim(signedPayload()))).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('cecabankCodeToCurrency: 978 → EUR; desconocido tal cual', () => {
    expect(cecabankCodeToCurrency('978')).toBe('EUR');
    expect(cecabankCodeToCurrency('123')).toBe('123');
  });
});
