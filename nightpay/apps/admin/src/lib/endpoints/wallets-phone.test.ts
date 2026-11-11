import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authedFetch } from '../http';
import { findWalletsByPhone } from './wallets';

vi.mock('../http', () => ({ authedFetch: vi.fn(), apiError: vi.fn(async () => new Error('No')), totpAwareError: vi.fn() }));
beforeEach(() => {
  vi.mocked(authedFetch).mockReset();
});

describe('buscar un saldo por el teléfono', () => {
  it('va en el cuerpo de un POST, nunca en la URL (no acaba en los logs)', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response);
    await findWalletsByPhone('600 12 34 56');
    expect(authedFetch).toHaveBeenCalledWith('/v1/reception/wallets/by-phone', { method: 'POST', body: JSON.stringify({ phone: '600 12 34 56' }) });
    expect(String(vi.mocked(authedFetch).mock.calls[0]![0])).not.toContain('600');
  });
});
