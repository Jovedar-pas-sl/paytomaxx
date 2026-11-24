import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import {
  RedsysAdapter,
  checkRedsysReplayWindow,
  currencyToRedsysCode,
  parseFormUrlEncoded,
  redsysCodeToCurrency,
  redsysSignatureMatches,
} from './redsys.adapter';

// Credenciales PÚBLICAS de pruebas de Redsys (comercio de test de su doc).
// Nunca pongas aquí las de producción.
const MERCHANT_CODE = '999008881';
const TERMINAL = '1';
const SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

function makeAdapter(opts?: { withCreds?: boolean; apiUrl?: string; merchantName?: string }) {
  const withCreds = opts?.withCreds ?? true;
  const apiUrl = opts?.apiUrl ?? 'https://sis-t.redsys.es:25443/sis/realizarPago';
  const config = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      if (key === 'REDSYS_API_URL') return apiUrl;
      if (key === 'NEXT_PUBLIC_API_URL') return 'https://api.paytomaxx.com';
      if (key === 'REDSYS_MERCHANT_NAME') return opts?.merchantName;
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

  // Fase 1B — el cliente elige botón e idioma en la página de pago.
  function merchantParams(fields: Record<string, string>): Record<string, string> {
    return JSON.parse(Buffer.from(fields.Ds_MerchantParameters!, 'base64').toString('utf8'));
  }
  const base = {
    tenantId: '00000000-0000-0000-0000-000000000000',
    paymentId: 'aabbccdd-1122-3344-5566-778899aabbcc',
    amountCents: 10_500,
    currency: 'EUR',
    terminalExternalId: '',
    reference: 'aabbccdd-1122-3344-5566-778899aabbcc',
  };

  it('botón Apple Pay / Google Pay → xpay; tarjeta → C', async () => {
    const adapter = makeAdapter();
    const wallet = await adapter.authorize({ ...base, payMethod: 'wallet' });
    const card = await adapter.authorize({ ...base, payMethod: 'card' });
    expect(merchantParams(wallet.checkoutForm!.fields).DS_MERCHANT_PAYMETHODS).toBe('xpay');
    expect(merchantParams(card.checkoutForm!.fields).DS_MERCHANT_PAYMETHODS).toBe('C');
  });

  it('sin botón elegido no fuerza método (Redsys enseña todo)', async () => {
    const adapter = makeAdapter();
    const r = await adapter.authorize(base);
    expect(merchantParams(r.checkoutForm!.fields).DS_MERCHANT_PAYMETHODS).toBeUndefined();
  });

  it('inglés → página del banco en inglés y vuelta con lang=en', async () => {
    const adapter = makeAdapter();
    const r = await adapter.authorize({ ...base, language: 'en' });
    const p = merchantParams(r.checkoutForm!.fields);
    expect(p.DS_MERCHANT_CONSUMERLANGUAGE).toBe('002');
    expect(p.DS_MERCHANT_URLOK).toContain('&lang=en');
    expect(p.DS_MERCHANT_AMOUNT).toBe('10500');
  });

  it('francés → 004 y portugués → 009 (página del banco en su idioma) y vuelta con su lang', async () => {
    const fr = merchantParams((await makeAdapter().authorize({ ...base, language: 'fr' })).checkoutForm!.fields);
    expect(fr.DS_MERCHANT_CONSUMERLANGUAGE).toBe('004');
    expect(fr.DS_MERCHANT_URLOK).toContain('&lang=fr');
    expect(fr.DS_MERCHANT_URLKO).toContain('&lang=fr');
    const pt = merchantParams((await makeAdapter().authorize({ ...base, language: 'pt' })).checkoutForm!.fields);
    expect(pt.DS_MERCHANT_CONSUMERLANGUAGE).toBe('009');
    expect(pt.DS_MERCHANT_URLOK).toContain('&lang=pt');
    expect(pt.DS_MERCHANT_AMOUNT).toBe('10500');
  });

  it('concepto con la marca; nombre del comercio solo si se configura', async () => {
    const plain = merchantParams((await makeAdapter().authorize(base)).checkoutForm!.fields);
    expect(plain.DS_MERCHANT_PRODUCTDESCRIPTION).toBe('OxioPay aabbccdd');
    expect(plain.DS_MERCHANT_MERCHANTNAME).toBeUndefined();
    const named = merchantParams(
      (await makeAdapter({ merchantName: 'OXIOPAY, S.L.' }).authorize(base)).checkoutForm!.fields,
    );
    expect(named.DS_MERCHANT_MERCHANTNAME).toBe('OXIOPAY SL');
  });

  it('castellano → 001 y vuelta sin parámetro de idioma', async () => {
    const adapter = makeAdapter();
    const p = merchantParams((await adapter.authorize({ ...base, language: 'es' })).checkoutForm!.fields);
    expect(p.DS_MERCHANT_CONSUMERLANGUAGE).toBe('001');
    expect(p.DS_MERCHANT_URLOK).not.toContain('lang=');
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

  // El happy path (firma válida) está en 'notificación firmada' más abajo.

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

// ─── Notificación firmada (happy path) ───────────────────────────────
// Firmamos con redsys-easy igual que firma Redsys: clave derivada del nº de
// pedido. `Ds_Merchant_Order` solo está para que el helper encuentre el order.
const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';

function signedNotification(fields: Record<string, string>): string {
  const signed = serializeAndSignJSONRequest(SECRET, {
    Ds_Merchant_Order: fields.Ds_Order,
    ...fields,
  } as any);
  return [
    `Ds_SignatureVersion=${signed.Ds_SignatureVersion}`,
    `Ds_MerchantParameters=${encodeURIComponent(signed.Ds_MerchantParameters)}`,
    `Ds_Signature=${encodeURIComponent(signed.Ds_Signature)}`,
  ].join('&');
}

describe('RedsysAdapter webhook — notificación firmada', () => {
  let adapter: RedsysAdapter;
  beforeEach(() => {
    adapter = makeAdapter();
  });

  const OK_FIELDS = {
    Ds_Order: 'a1b2c3d4e5f6',
    Ds_MerchantCode: MERCHANT_CODE,
    Ds_Response: '0000',
    Ds_ProcessedPayMethod: '78',
    Ds_Card_Brand: '1',
  };
  /** Lo que dice de la tarjeta OK_FIELDS (lo demás, sin dato). */
  const OK_CARD = { payMethodCode: '78', cardBrand: '1', cardType: null, cardCountry: null, cardLast4: null, authCode: null, secure3ds: null };

  it('verifyWebhook acepta la firma y devuelve el Ds_Order como paymentRef', () => {
    const result = adapter.verifyWebhook({}, Buffer.from(signedNotification(OK_FIELDS)));
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.paymentRef).toBe('a1b2c3d4e5f6');
      expect(result.externalEventId).toBe('a1b2c3d4e5f6-0000');
    }
  });

  it('una denegación y un OK del mismo pedido son eventos distintos (no se deduplican)', () => {
    const ko = adapter.verifyWebhook(
      {},
      Buffer.from(signedNotification({ ...OK_FIELDS, Ds_Response: '0190' })),
    );
    const ok = adapter.verifyWebhook({}, Buffer.from(signedNotification(OK_FIELDS)));
    expect(ko.valid && ok.valid).toBe(true);
    if (ko.valid && ok.valid) expect(ko.externalEventId).not.toBe(ok.externalEventId);
  });

  it('mapWebhookToFsmEvent usa el _paymentId resuelto por el controller', () => {
    const body = parseFormUrlEncoded(
      `${signedNotification(OK_FIELDS)}&_paymentId=${PAYMENT_ID}`,
    );
    expect(adapter.mapWebhookToFsmEvent(body)).toEqual({
      paymentId: PAYMENT_ID,
      event: { type: 'AUTHORIZED', providerTxId: 'a1b2c3d4e5f6', provider: 'REDSYS' },
      card: OK_CARD,
    });
  });

  it('sin _paymentId (guardado nada más comprobar la firma) → evento sin cobro: el processor lo busca por el pedido', () => {
    const body = parseFormUrlEncoded(signedNotification(OK_FIELDS));
    expect(adapter.mapWebhookToFsmEvent(body)).toEqual({
      paymentId: '',
      event: { type: 'AUTHORIZED', providerTxId: 'a1b2c3d4e5f6', provider: 'REDSYS' },
      card: OK_CARD,
    });
  });

  it('denegación → null: el estado final lo decide la conciliación (o se resuelve a mano)', () => {
    // Redsys deja reintentar en su página con el mismo pedido. Si marcáramos
    // FAILED (estado final) y luego llegara el OK, el cobro quedaría perdido.
    const body = parseFormUrlEncoded(
      `${signedNotification({ ...OK_FIELDS, Ds_Response: '0190' })}&_paymentId=${PAYMENT_ID}`,
    );
    expect(adapter.mapWebhookToFsmEvent(body)).toBeNull();
  });

  it('aviso de devolución (type 3, 0900) del mismo pedido → null, no es un cobro', () => {
    const body = parseFormUrlEncoded(
      `${signedNotification({ ...OK_FIELDS, Ds_Response: '0900', Ds_TransactionType: '3' })}&_paymentId=${PAYMENT_ID}`,
    );
    expect(adapter.mapWebhookToFsmEvent(body)).toBeNull();
  });

  it('firma manipulada → null aunque traiga _paymentId', () => {
    const tampered = signedNotification(OK_FIELDS).replace(/Ds_Signature=[^&]+/, 'Ds_Signature=AAAA');
    const body = parseFormUrlEncoded(`${tampered}&_paymentId=${PAYMENT_ID}`);
    expect(adapter.mapWebhookToFsmEvent(body)).toBeNull();
  });

  it('parseNotification extrae método, tarjeta y autorización de un aviso aprobado', () => {
    const body = parseFormUrlEncoded(
      signedNotification({
        ...OK_FIELDS,
        Ds_Amount: '10500',
        Ds_Currency: '978',
        Ds_TransactionType: '0',
        Ds_Card_Type: 'D',
        Ds_Card_Country: '724',
        Ds_Card_Number: '454881******0003',
        Ds_AuthorisationCode: '123456',
        Ds_SecurePayment: '1',
      }),
    );
    expect(adapter.parseNotification(body)).toEqual({
      order: 'a1b2c3d4e5f6',
      response: '0000',
      transactionType: '0',
      approved: true,
      amountCents: 10_500,
      currency: 'EUR',
      payMethodCode: '78',
      cardBrand: '1',
      cardType: 'D',
      cardCountry: '724',
      cardLast4: '0003',
      authCode: '123456',
      secure3ds: true,
    });
  });

  it('parseNotification: denegación → approved=false; firma mala → null', () => {
    const denied = parseFormUrlEncoded(signedNotification({ ...OK_FIELDS, Ds_Response: '0190' }));
    expect(adapter.parseNotification(denied)?.approved).toBe(false);
    const tampered = parseFormUrlEncoded(
      signedNotification(OK_FIELDS).replace(/Ds_Signature=[^&]+/, 'Ds_Signature=AAAA'),
    );
    expect(adapter.parseNotification(tampered)).toBeNull();
  });

  it('firma en base64url (como la manda Redsys) también vale', () => {
    const urlSafe = signedNotification(OK_FIELDS).replace(/Ds_Signature=([^&]+)/, (_m, sig: string) => {
      const b64 = decodeURIComponent(sig);
      return `Ds_Signature=${encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_'))}`;
    });
    expect(adapter.verifyWebhook({}, Buffer.from(urlSafe)).valid).toBe(true);
  });

  it('extractTokenizationData lee el body form-urlencoded real', () => {
    const raw = Buffer.from(
      signedNotification({
        ...OK_FIELDS,
        Ds_Merchant_Identifier: 'tok-123456789',
        Ds_Card_Number: '454881******0003',
        Ds_ExpiryDate: '4912',
      }),
    );
    const token = adapter.extractTokenizationData(raw);
    expect(token?.identifier).toBe('tok-123456789');
    expect(token?.cardLast4).toBe('0003');
  });
});

describe('RedsysAdapter.proveApproval — el aviso firmado es la prueba (importe incluido)', () => {
  const adapter = makeAdapter();
  const APPROVED = {
    Ds_Order: 'a1b2c3d4e5f6',
    Ds_MerchantCode: MERCHANT_CODE,
    Ds_Response: '0000',
    Ds_TransactionType: '0',
    Ds_Amount: '10500',
    Ds_Currency: '978',
  };
  const claim = (fields: Record<string, string>, providerTxId = 'a1b2c3d4e5f6') => ({
    paymentId: PAYMENT_ID,
    providerTxId,
    payload: parseFormUrlEncoded(`${signedNotification(fields)}&_paymentId=${PAYMENT_ID}`),
  });

  it('aprobado → importe y moneda de la parte firmada', async () => {
    expect(await adapter.proveApproval(claim(APPROVED))).toEqual({
      kind: 'confirmed',
      amountCents: 10_500,
      currency: 'EUR',
    });
  });

  it('denegado, de otro pedido, sin importe o con firma tocada → no prueba nada', async () => {
    expect(await adapter.proveApproval(claim({ ...APPROVED, Ds_Response: '0190' }))).toMatchObject({
      kind: 'rejected',
      reason: 'no-aprobado',
    });
    expect(await adapter.proveApproval(claim(APPROVED, 'otro-pedido'))).toMatchObject({
      kind: 'rejected',
      reason: 'pedido-distinto',
    });
    const { Ds_Amount: _omit, ...noAmount } = APPROVED;
    expect(await adapter.proveApproval(claim(noAmount))).toMatchObject({
      kind: 'rejected',
      reason: 'aviso-sin-importe',
    });
    const tampered = claim(APPROVED);
    tampered.payload.Ds_Signature = 'AAAA';
    expect(await adapter.proveApproval(tampered)).toMatchObject({ kind: 'rejected' });
  });

  it('el importe no se puede cambiar sin romper la firma', async () => {
    const signed = parseFormUrlEncoded(signedNotification(APPROVED));
    const params = JSON.parse(Buffer.from(String(signed.Ds_MerchantParameters), 'base64').toString('utf8'));
    const forged = {
      ...signed,
      Ds_MerchantParameters: Buffer.from(JSON.stringify({ ...params, Ds_Amount: '1' })).toString('base64'),
    };
    expect(adapter.parseNotification(forged)).toBeNull();
  });
});

describe('redsysSignatureMatches — firma en tiempo constante', () => {
  const fields = { Ds_Order: '1234abcdefgh', Ds_MerchantCode: MERCHANT_CODE, Ds_Response: '0000' };
  const signed = serializeAndSignJSONRequest(SECRET, { Ds_Merchant_Order: fields.Ds_Order, ...fields } as any);

  it('acepta la firma que calcula redsys-easy (base64 y base64url)', () => {
    expect(redsysSignatureMatches(SECRET, signed.Ds_MerchantParameters, signed.Ds_Signature)).toBe(true);
    const urlSafe = signed.Ds_Signature.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(redsysSignatureMatches(SECRET, signed.Ds_MerchantParameters, urlSafe)).toBe(true);
  });

  it('rechaza otra clave, otra firma, parámetros tocados o basura', () => {
    expect(redsysSignatureMatches('Mk9m98IfEblmPfrpsawt7BmxObt98Jev', signed.Ds_MerchantParameters, signed.Ds_Signature)).toBe(false);
    expect(redsysSignatureMatches(SECRET, signed.Ds_MerchantParameters, 'AAAA')).toBe(false);
    const other = Buffer.from(JSON.stringify({ ...fields, Ds_Response: '0190' })).toString('base64');
    expect(redsysSignatureMatches(SECRET, other, signed.Ds_Signature)).toBe(false);
    expect(redsysSignatureMatches(SECRET, 'no-es-base64-json', signed.Ds_Signature)).toBe(false);
    const noOrder = Buffer.from(JSON.stringify({ Ds_Response: '0000' })).toString('base64');
    expect(redsysSignatureMatches(SECRET, noOrder, signed.Ds_Signature)).toBe(false);
  });
});

describe('redsysCodeToCurrency', () => {
  it('978 → EUR; desconocido tal cual (no cuadrará); sin moneda → null', () => {
    expect(redsysCodeToCurrency('978')).toBe('EUR');
    expect(redsysCodeToCurrency('999')).toBe('999');
    expect(redsysCodeToCurrency(null)).toBeNull();
  });
});

describe('RedsysAdapter.getStatus() — consulta no disponible (pendiente de BBVA)', () => {
  it('no llama al banco (nada del tipo 44, «Borrar Referencia») y devuelve UNKNOWN', async () => {
    const adapter = makeAdapter();
    const getApi = vi.spyOn(adapter as unknown as { getApi: () => unknown }, 'getApi');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await adapter.getStatus('v1', '1234abcdefgh')).toBe('UNKNOWN');
      expect(getApi).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('lo dice en el log una vez, no en cada consulta', async () => {
    const adapter = makeAdapter();
    const logger = (adapter as unknown as { logger: { warn: (msg: string) => void } }).logger;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await adapter.getStatus('v1', '1234aaaa');
    await adapter.getStatus('v1', '1234bbbb');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'consulta de Redsys no disponible: falta el servicio de consulta de operaciones',
    );
  });
});
