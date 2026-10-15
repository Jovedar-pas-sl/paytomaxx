import { describe, it, expect, afterEach, vi } from 'vitest';
import { BscVerifier } from './bsc.verifier';
import { PolygonVerifier } from './polygon.verifier';

const TO = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const rate = () => Promise.resolve(1.07);
const input = { externalTxId: TX, expectedToAddress: TO, expectedAmountCents: 10_000 }; // 107 USDT

function row(to: string, value: string, extra: Record<string, string> = {}) {
  return { hash: TX, to, value, tokenDecimal: '18', timeStamp: '1760472000', confirmations: '50', ...extra };
}

function stubExplorer(resultsByCall: Array<unknown[]>) {
  const fetchMock = vi.fn();
  for (const result of resultsByCall) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: result.length ? '1' : '0', result }) });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('BscVerifier (USDT-BEP20)', () => {
  const v = new BscVerifier('key', rate);

  it('pide las transferencias USDT de la dirección de la chica (documentado: address + contractaddress)', async () => {
    const f = stubExplorer([[row(TO, '107000000000000000000')]]);
    await v.verify(input);
    const url = String(f.mock.calls[0]![0]);
    expect(url).toContain(`address=${TO}`);
    expect(url).toContain('contractaddress=0x55d398326f99059ff775485246999027b3197955');
  });

  it('suma TODAS las transferencias de la tx a su dirección y compara en USDT', async () => {
    stubExplorer([[row(TO, '50000000000000000000'), row(TO, '57000000000000000000'), row(OTHER, '1000000000000000000')]]);
    expect(await v.verify(input)).toMatchObject({ matched: true, status: 'MATCHED', actualAmountUsdt: 107, actualAmountCents: null });
  });

  it('la tx solo envía a otra dirección → MISMATCH destino_distinto', async () => {
    stubExplorer([[row(OTHER, '107000000000000000000')]]);
    const r = await v.verify(input);
    expect(r.status).toBe('MISMATCH');
    expect(r.reason).toMatch(/^destino_distinto: /);
  });

  it('1 % de diferencia → MISMATCH (margen ±0,5 %)', async () => {
    stubExplorer([[row(TO, '106000000000000000000')]]);
    expect((await v.verify(input)).reason).toMatch(/^importe_distinto: llegaron 106,00 USDT/);
  });

  it('pocas confirmaciones → aún sin conciliar', async () => {
    stubExplorer([[row(TO, '107000000000000000000', { confirmations: '2' })]]);
    expect(await v.verify(input)).toMatchObject({ matched: false, status: 'UNRECONCILED', reason: 'bsc_unconfirmed' });
  });

  it('la tx no aparece entre sus transferencias → sin conciliar (se reintenta)', async () => {
    stubExplorer([[]]);
    expect(await v.verify(input)).toMatchObject({ status: 'UNRECONCILED' });
  });
});

describe('PolygonVerifier (USDC nativo y USDC.e)', () => {
  const v = new PolygonVerifier('key', rate);

  it('si no está en el USDC nativo prueba el puenteado (USDC.e) y suma lo que llegó', async () => {
    stubExplorer([[], [row(TO, '107000000', { tokenDecimal: '6', confirmations: '200' })]]);
    expect(await v.verify(input)).toMatchObject({ matched: true, actualAmountUsdt: 107 });
  });

  it('destino distinto → MISMATCH', async () => {
    stubExplorer([[row(OTHER, '107000000', { tokenDecimal: '6', confirmations: '200' })]]);
    expect((await v.verify(input)).status).toBe('MISMATCH');
  });
});
