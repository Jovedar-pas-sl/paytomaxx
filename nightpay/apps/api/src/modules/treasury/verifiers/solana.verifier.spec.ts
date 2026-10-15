import { describe, it, expect, afterEach, vi } from 'vitest';
import { SolanaVerifier } from './solana.verifier';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = 'ChicaWa11etChicaWa11etChicaWa11etChicaWa11e';
const ATA = 'ChicaAtaChicaAtaChicaAtaChicaAtaChicaAtaCh';
const OTHER_ATA = 'OtraAtaOtraAtaOtraAtaOtraAtaOtraAtaOtraAta';
const input = { externalTxId: 'sig1', expectedToAddress: WALLET, expectedAmountCents: 10_000, expectedAmountUsdt: 107 };

function checked(destination: string, uiAmount: number) {
  return { parsed: { type: 'transferChecked', info: { mint: MINT, destination, tokenAmount: { uiAmount } } } };
}

function tx(instructions: unknown[], inner: unknown[] = []) {
  return {
    result: {
      blockTime: 1760472000,
      transaction: { message: { accountKeys: ['payer', ATA, OTHER_ATA], instructions } },
      meta: {
        postTokenBalances: [
          { accountIndex: 1, mint: MINT, owner: WALLET },
          { accountIndex: 2, mint: MINT, owner: 'OtraPersona' },
        ],
        innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [],
      },
    },
  };
}

function stubRpc(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }));
}

afterEach(() => vi.unstubAllGlobals());

describe('SolanaVerifier (USDC-SOL)', () => {
  const v = new SolanaVerifier(undefined, () => Promise.resolve(1.07));

  it('suma todas las transferencias USDC a su cuenta (también las internas) y compara en USDT', async () => {
    stubRpc(tx([checked(OTHER_ATA, 10), checked(ATA, 50)], [checked(ATA, 57)]));
    expect(await v.verify(input)).toMatchObject({ matched: true, status: 'MATCHED', actualAmountUsdt: 107, actualAmountCents: null });
  });

  it('una sola transferencia a su cuenta por menos → MISMATCH importe_distinto (no se queda con la primera)', async () => {
    stubRpc(tx([checked(ATA, 50)]));
    expect((await v.verify(input)).reason).toMatch(/^importe_distinto: llegaron 50,00 USDT/);
  });

  it('nada a su cuenta → MISMATCH destino_distinto', async () => {
    stubRpc(tx([checked(OTHER_ATA, 107)]));
    expect((await v.verify(input)).reason).toMatch(/^destino_distinto: /);
  });

  it('transfer sin mint a una cuenta que no es de USDC no cuenta', async () => {
    stubRpc(tx([{ parsed: { type: 'transfer', info: { destination: WALLET, amount: '107000000' } } }]));
    expect((await v.verify(input)).status).toBe('MISMATCH');
  });
});
