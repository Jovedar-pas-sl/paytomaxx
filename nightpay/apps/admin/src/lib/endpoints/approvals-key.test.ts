import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_UP_TOKEN_HEADER } from '@nightpay/contracts';
import { authedFetch } from '../http';
import { approveApproval } from './approvals';

vi.mock('../http', () => ({ authedFetch: vi.fn(), apiError: vi.fn(), totpAwareError: vi.fn(async () => new Error('No')) }));
beforeEach(() => {
  vi.mocked(authedFetch).mockReset();
  vi.mocked(authedFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response);
});

describe('aprobar una solicitud', () => {
  it('con el código 2FA, en el cuerpo', async () => {
    await approveApproval('a-1', '123456');
    expect(authedFetch).toHaveBeenCalledWith('/v1/approvals/a-1/approve', { method: 'POST', body: JSON.stringify({ totpCode: '123456' }) });
  });

  it('sin 2FA, con la prueba de la llave en su cabecera (sin código)', async () => {
    await approveApproval('a-1', undefined, 'prueba-de-llave');
    expect(authedFetch).toHaveBeenCalledWith('/v1/approvals/a-1/approve', {
      method: 'POST',
      body: '{}',
      headers: { [STEP_UP_TOKEN_HEADER]: 'prueba-de-llave' },
    });
  });
});
