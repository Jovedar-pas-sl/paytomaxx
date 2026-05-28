import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RedsysAdapter,
  checkRedsysReplayWindow,
  currencyToRedsysCode,
  parseFormUrlEncoded,
} from './redsys.adapter';

const MERCHANT_CODE = '353443385';
const TERMINAL = '1';
const SECRET = 'KnNPcjbWhlmxINSrAVz08hGK5BdYlLap';

function makeAdapter(opts?: { withCreds?: boolean; apiUrl?: string }) {
  const withCreds = opts?.withCreds ?? true;
  const apiUrl = opts?.apiUrl ?? 'https://sis-t.redsys.es:25443/sis/realizarPago';
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      if (key === 'REDSYS_API_URL') return apiUrl;
      if (key === 'NEXT_PUBLIC_API_URL') return 'https://api.paytomaxx.com';
      if (!withCreds) return undefined;
      if (key === 'REDSYS_MERCHANT_CODE') return MERCHANT_CODE;
      if (key === 'REDSYS_TERMINAL') return TERMINAL;
      if (key === 'REDSYS_SECRET_KEY') return SECRET;
      return undefined;
    }),
  };
  const metrics = {
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RedsysAdapter(config as any, metrics as any);
}

describe('currencyToRedsysCode', () => {
  it('EUR → 978', () => expect(currencyToRedsysCode('EUR')).toBe('978'));
  it('USD → 840', () => expect(currencyToRedsysCode('USD')).toBe('840'));
  it('desconocida → 978 fallback', () => expect(currencyToRedsysCode('XXX')).toBe('978'));
});

describe('parseFormUrlEncoded', () => {
  it('parsea pares clave=valor separados por &', () => {
    expect(parseFormUrlEncoded('a=1&b=2&c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });
  it('decodifica URL-encoding y +', () => {
    expect(parseFormUrlEncoded('descripcion=hola+mundo%2Fcobro')).toEqual({
      descripcion: 'hola mundo/cobro',
    });
  });
  it('handle pair sin =', () => {
    expect(parseFormUrlEncoded('a&b=2')).toEqual({ a: '', b: '2' });
  });
});

describe('RedsysAdapter.authorize() — flujo Redsys SIS', () => {
  it('devuelve checkoutForm con los 3 campos Ds_*', async () => {
    const adapter = makeAdapter();
    const result = await adapter.authorize({
      tenantId: '00000000-0000-0000-0000-000000000000',
      paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'aabbccdd-1122-3344-5566-778899aabbcc',
    });
    expect(result.provider).toBe('REDSYS');
    expect(result.status).toBe('PROCESSING');
    expect(result.checkoutForm).toBeDefined();
    expect(result.checkoutForm?.method).toBe('POST');

    const f = result.checkoutForm!.fields;
    expect(f.Ds_SignatureVersion).toBe('HMAC_SHA256_V1');
    expect(f.Ds_MerchantParameters).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    expect(f.Ds_Signature).toMatch(/^[A-Za-z0-9+/=]+$/);

    // providerTxId = dsOrder generado por randomTransactionId (4 dígitos + alfanum)
    expect(result.providerTxId).toMatch(/^[0-9]{4}[A-Za-z0-9]*$/);
    expect(result.providerTxId.length).toBeLessThanOrEqual(12);
    expect(result.providerTxId.length).toBeGreaterThanOrEqual(4);
  });

  it('apunta el form a la URL Redsys sandbox por defecto', async () => {
    const adapter = makeAdapter();
    const result = await adapter.authorize({
      tenantId: '00000000-0000-0000-0000-000000000000',
      paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'ref',
    });
    expect(result.checkoutForm?.action).toContain('sis-t.redsys.es');
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

  it('cada authorize genera dsOrder distinto (random)', async () => {
    const adapter = makeAdapter();
    const r1 = await adapter.authorize({
      tenantId: '00000000-0000-0000-0000-000000000000',
      paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'r1',
    });
    const r2 = await adapter.authorize({
      tenantId: '00000000-0000-0000-0000-000000000000',
      paymentId: 'aabbccdd-1122-3344-5566-778899aabbcd',
      amountCents: 100,
      currency: 'EUR',
      terminalExternalId: '',
      reference: 'r2',
    });
    expect(r1.providerTxId).not.toBe(r2.providerTxId);
  });
});

describe('RedsysAdapter.verifyWebhook — rejection paths', () => {
  let adapter: RedsysAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  // NOTA: el happy path de "firma válida → accepted" no se testea aquí
  // unitariamente porque requiere usar internals no-exportados de
  // redsys-easy. Se valida en integración real con sandbox Redsys.

  it('rechaza si faltan campos requeridos', () => {
    const result = adapter.verifyWebhook({}, Buffer.from('foo=bar'));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing-required-fields');
  });

  it('rechaza si solo viene Ds_SignatureVersion', () => {
    const result = adapter.verifyWebhook(
      {},
      Buffer.from('Ds_SignatureVersion=HMAC_SHA256_V1'),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('missing-required-fields');
  });

  it('rechaza si creds NO configuradas (defensa)', () => {
    const adapter2 = makeAdapter({ withCreds: false });
    const body =
      'Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=eyJEc19PcmRlciI6IngifQ==&Ds_Signature=fakeSig123';
    const result = adapter2.verifyWebhook({}, Buffer.from(body));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('creds-not-configured');
  });

  it('rechaza firma malformada (no base64 parseable)', () => {
    const body =
      'Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=NOT_BASE64_!!!&Ds_Signature=alsoNotBase64!!!';
    const result = adapter.verifyWebhook({}, Buffer.from(body));
    expect(result.valid).toBe(false);
    // El reason puede ser 'signature-mismatch' o similar — lo importante
    // es que NO acepte el body inválido como válido.
  });

  it('rechaza firma incorrecta con params válidos', () => {
    // Params legítimos pero firma calculada con un secreto distinto →
    // verifyWebhook debe rechazar con signature-mismatch.
    const params = Buffer.from(
      JSON.stringify({
        Ds_Order: '1234abcdefgh',
        Ds_MerchantCode: MERCHANT_CODE,
        Ds_Response: '0000',
      }),
      'utf8',
    ).toString('base64');
    const body = `Ds_SignatureVersion=HMAC_SHA256_V1&Ds_MerchantParameters=${encodeURIComponent(params)}&Ds_Signature=fakesig123`;
    const result = adapter.verifyWebhook({}, Buffer.from(body));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature-mismatch');
  });
});

describe('checkRedsysReplayWindow', () => {
  // 2026-05-28 12:00:00 UTC = 2026-05-28 14:00 Madrid (DST CEST)
  const NOW = Date.UTC(2026, 4, 28, 12, 0, 0);
  const WINDOW = 30 * 60 * 1000;

  it('acepta timestamps vacíos (sin Ds_Date/Ds_Hour) — compat', () => {
    expect(checkRedsysReplayWindow('', '', WINDOW, NOW)).toEqual({ ok: true });
    expect(checkRedsysReplayWindow('28/05/2026', '', WINDOW, NOW)).toEqual({ ok: true });
  });

  it('acepta timestamps dentro de ventana 30 min', () => {
    expect(checkRedsysReplayWindow('28/05/2026', '11:50', WINDOW, NOW)).toEqual({ ok: true });
    expect(checkRedsysReplayWindow('28/05/2026', '12:00', WINDOW, NOW)).toEqual({ ok: true });
  });

  it('rechaza timestamps muy viejos (más de window + 2h DST skew)', () => {
    const result = checkRedsysReplayWindow('25/05/2026', '12:00', WINDOW, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('replay-timestamp-too-old');
  });

  it('rechaza timestamps muy futuros (más de 5 min + 2h DST skew)', () => {
    const result = checkRedsysReplayWindow('29/05/2026', '12:00', WINDOW, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('replay-timestamp-future');
  });

  it('rechaza formato malformado', () => {
    const r1 = checkRedsysReplayWindow('2026-05-28', '12:00', WINDOW, NOW);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('replay-timestamp-malformed');
    const r2 = checkRedsysReplayWindow('28/05/2026', '12-00', WINDOW, NOW);
    expect(r2.ok).toBe(false);
  });

  it('maneja URL-encoded "/" (Redsys a veces los envía así)', () => {
    expect(
      checkRedsysReplayWindow('28%2F05%2F2026', '11:50', WINDOW, NOW),
    ).toEqual({ ok: true });
  });
});
