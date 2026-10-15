import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TronVerifier } from './tron.verifier';

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const EXPECTED_TO = 'TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV';
const TX_HASH = '0xabc123';

// 100 EUR @ 1.07 rate = 107 USDT
const EUR_TO_USDT_RATE = 1.07;
const EXPECTED_CENTS = 10_000;

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    hash: TX_HASH,
    timestamp: 1735660800000,
    confirmed: true,
    contractRet: 'SUCCESS',
    trc20TransferInfo: [
      {
        contract_address: USDT_TRC20_CONTRACT,
        to_address: EXPECTED_TO,
        amount_str: '107000000', // 107 USDT (6 decimals)
      },
    ],
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('TronVerifier.verify', () => {
  let verifier: TronVerifier;
  const rate = () => Promise.resolve(EUR_TO_USDT_RATE);

  beforeEach(() => {
    verifier = new TronVerifier('test-api-key', rate);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns MATCHED on happy path (correct contract, address, amount, confirmed)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody()));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(true);
    expect(result.status).toBe('MATCHED');
    // Lo recibido va en USDT; en EUR lo pasa el servicio con la foto del tipo del pago.
    expect(result.actualAmountUsdt).toBe(107);
    expect(result.actualAmountCents).toBeNull();
  });

  it('returns MISMATCH when destination address differs', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        {
          contract_address: USDT_TRC20_CONTRACT,
          to_address: 'TWRONGwrongwrongwrongwrongwrongwron',
          amount_str: '107000000',
        },
      ],
    })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('MISMATCH');
    expect(result.reason).toMatch(/^destino_distinto: /);
  });

  it('returns MISMATCH when amount is outside tolerance', async () => {
    // Esperado 107 USDT, actual 90 USDT (16% off → mismatch)
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        {
          contract_address: USDT_TRC20_CONTRACT,
          to_address: EXPECTED_TO,
          amount_str: '90000000',
        },
      ],
    })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('MISMATCH');
    expect(result.reason).toBe('importe_distinto: llegaron 90,00 USDT y se esperaban 107,00 USDT (margen ±0,54)');
  });

  it('returns MATCHED when amount is within 0.5% tolerance', async () => {
    // 107 ± 0,5 % → ±0,535. Probamos 106,6.
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        {
          contract_address: USDT_TRC20_CONTRACT,
          to_address: EXPECTED_TO,
          amount_str: '106600000',
        },
      ],
    })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(true);
    expect(result.status).toBe('MATCHED');
  });

  it('returns UNRECONCILED when transaction not yet confirmed', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({ confirmed: false })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.reason).toBe('tron_unconfirmed');
  });

  it('returns UNRECONCILED when transaction not found (no contractRet)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { hash: TX_HASH }));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.reason).toBe('tron_pending_or_unknown');
  });

  it('returns MISMATCH when contractRet is not SUCCESS', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({ contractRet: 'REVERT' })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('MISMATCH');
    expect(result.reason).toMatch(/^tx_fallida: .*REVERT/);
  });

  it('returns MISMATCH when tx has no USDT transfer (wrong token contract)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        {
          contract_address: 'TDifferentTokenContract00000000000', // not USDT
          to_address: EXPECTED_TO,
          amount_str: '107000000',
        },
      ],
    })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('MISMATCH');
    expect(result.reason).toMatch(/^sin_usdt: /);
  });

  it('returns UNRECONCILED on HTTP error from Tronscan', async () => {
    vi.stubGlobal('fetch', mockFetch(503, {}));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.reason).toBe('tron_http_error');
  });

  it('returns UNRECONCILED on fetch exception (network down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENETUNREACH')));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(false);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.reason).toBe('tron_exception');
  });

  it('compares addresses case-insensitively', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        {
          contract_address: USDT_TRC20_CONTRACT.toUpperCase(),
          to_address: EXPECTED_TO.toLowerCase(),
          amount_str: '107000000',
        },
      ],
    })));
    const result = await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO, // mixed case
      expectedAmountCents: EXPECTED_CENTS,
    });
    expect(result.matched).toBe(true);
  });

  it('passes TRON-PRO-API-KEY header when apiKey provided', async () => {
    const fetchMock = mockFetch(200, makeBody());
    vi.stubGlobal('fetch', fetchMock);
    await verifier.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['TRON-PRO-API-KEY']).toBe('test-api-key');
  });

  it('omits API key header when not configured', async () => {
    const verifierNoKey = new TronVerifier(undefined, rate);
    const fetchMock = mockFetch(200, makeBody());
    vi.stubGlobal('fetch', fetchMock);
    await verifierNoKey.verify({
      externalTxId: TX_HASH,
      expectedToAddress: EXPECTED_TO,
      expectedAmountCents: EXPECTED_CENTS,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['TRON-PRO-API-KEY']).toBeUndefined();
  });

  it('1 % de diferencia ya no pasa (antes ±2 %)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [{ contract_address: USDT_TRC20_CONTRACT, to_address: EXPECTED_TO, amount_str: '106000000' }],
    })));
    const result = await verifier.verify({ externalTxId: TX_HASH, expectedToAddress: EXPECTED_TO, expectedAmountCents: EXPECTED_CENTS });
    expect(result.status).toBe('MISMATCH');
  });

  it('mira TODAS las transferencias: la primera a otra persona no tapa la de la chica', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        { contract_address: USDT_TRC20_CONTRACT, to_address: 'TOtraChicaOtraChicaOtraChicaOtraCh', amount_str: '50000000' },
        { contract_address: USDT_TRC20_CONTRACT, to_address: EXPECTED_TO, amount_str: '107000000' },
      ],
    })));
    const result = await verifier.verify({ externalTxId: TX_HASH, expectedToAddress: EXPECTED_TO, expectedAmountCents: EXPECTED_CENTS });
    expect(result).toMatchObject({ matched: true, actualAmountUsdt: 107 });
  });

  it('suma las transferencias a su dirección (y solo de USDT)', async () => {
    vi.stubGlobal('fetch', mockFetch(200, makeBody({
      trc20TransferInfo: [
        { contract_address: USDT_TRC20_CONTRACT, to_address: EXPECTED_TO, amount_str: '50000000' },
        { contract_address: USDT_TRC20_CONTRACT, to_address: EXPECTED_TO, amount_str: '57000000' },
        { contract_address: 'TOtroTokenOtroTokenOtroTokenOtroTo', to_address: EXPECTED_TO, amount_str: '999000000' },
      ],
    })));
    const result = await verifier.verify({ externalTxId: TX_HASH, expectedToAddress: EXPECTED_TO, expectedAmountCents: EXPECTED_CENTS });
    expect(result).toMatchObject({ matched: true, actualAmountUsdt: 107 });
  });
});
