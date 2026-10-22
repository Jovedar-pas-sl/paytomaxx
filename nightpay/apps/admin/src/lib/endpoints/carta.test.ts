import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as carta from './carta';
import { authedFetch } from '../http';

vi.mock('../http', () => ({ authedFetch: vi.fn(), apiError: vi.fn(async () => new Error('Conflicto en la carta')) }));
beforeEach(() => { vi.mocked(authedFetch).mockReset(); });

describe('applyCartaTemplate', () => {
  it('sends one confirmed atomic request, leaving product prices to the server preset', async () => {
    const summary = { created: 12, updated: 0, kept: 1, skipped: 0 };
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, json: async () => summary } as Response);
    await expect(carta.applyCartaTemplate()).resolves.toEqual(summary);
    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect(authedFetch).toHaveBeenCalledWith('/v1/services/template', { method: 'POST', body: JSON.stringify({ confirm: true }) });
  });
  it('sends only the products the owner ticked, with what they saw', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: true, json: async () => ({ created: 0, updated: 1, kept: 0, skipped: 0 }) } as Response);
    const update = [{ id: 'copa', seen: { priceCents: 900, durationMin: null, sortOrder: 0, active: false } }];
    await carta.applyCartaTemplate(update);
    expect(authedFetch).toHaveBeenCalledWith('/v1/services/template', { method: 'POST', body: JSON.stringify({ confirm: true, update }) });
  });
  it('surfaces a conflict without falling back to individual writes', async () => {
    vi.mocked(authedFetch).mockResolvedValue({ ok: false, status: 409 } as Response);
    await expect(carta.applyCartaTemplate()).rejects.toThrow('Conflicto en la carta');
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });
});
