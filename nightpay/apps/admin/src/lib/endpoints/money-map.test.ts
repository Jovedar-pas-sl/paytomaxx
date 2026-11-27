import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMoneyMap } from './money-map';
import { authedFetch } from '../http';

vi.mock('../http', () => ({ authedFetch: vi.fn(), apiError: vi.fn(async () => new Error('No')) }));
beforeEach(() => {
  vi.mocked(authedFetch).mockReset();
  vi.mocked(authedFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
});
const url = () => vi.mocked(authedFetch).mock.calls[0]![0];

describe('fetchMoneyMap', () => {
  it('varias noches: manda fromAt y toAt', async () => {
    await fetchMoneyMap({ fromAt: '2026-11-13T05:00:00.000Z', toAt: '2026-11-16T05:00:00.000Z' });
    expect(url()).toBe('/v1/admin/money-map?fromAt=2026-11-13T05%3A00%3A00.000Z&toAt=2026-11-16T05%3A00%3A00.000Z');
  });
  it('sin toAt (la más nueva sigue abierta): solo fromAt', async () => {
    await fetchMoneyMap({ fromAt: '2026-11-13T05:00:00.000Z' });
    expect(url()).toBe('/v1/admin/money-map?fromAt=2026-11-13T05%3A00%3A00.000Z');
  });
  it('toAt sin fromAt no se manda; esta noche, sin nada; una noche y unas fechas, como antes', async () => {
    await fetchMoneyMap({ toAt: '2026-11-16T05:00:00.000Z' });
    await fetchMoneyMap({});
    await fetchMoneyMap({ night: 'n1' });
    await fetchMoneyMap({ from: '2026-11-01', to: '2026-11-25' });
    expect(vi.mocked(authedFetch).mock.calls.map((c) => c[0])).toEqual([
      '/v1/admin/money-map',
      '/v1/admin/money-map',
      '/v1/admin/money-map?night=n1',
      '/v1/admin/money-map?from=2026-11-01&to=2026-11-25',
    ]);
  });
});
