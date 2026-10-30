import { describe, expect, it, vi } from 'vitest';
import { WalletEventsRelay } from './wallet-events.relay';
import type { WalletEvent } from './wallet-events';

const W = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const C = 'b7e1d2c3-0000-4000-8000-00000000beef';

function makeRelay() {
  let onEvent: ((e: WalletEvent) => void) | null = null;
  let onResync: (() => void) | null = null;
  const unsubscribe = { event: vi.fn(), resync: vi.fn() };
  const listener = {
    onEvent: vi.fn((fn: (e: WalletEvent) => void) => {
      onEvent = fn;
      return unsubscribe.event;
    }),
    onResync: vi.fn((fn: () => void) => {
      onResync = fn;
      return unsubscribe.resync;
    }),
  };
  const hub = { notify: vi.fn(), resync: vi.fn() };
  const gateway = { emitWalletChargeUpdate: vi.fn() };
  const relay = new WalletEventsRelay(listener as never, hub as never, gateway as never);
  relay.onModuleInit();
  return {
    relay,
    hub,
    gateway,
    unsubscribe,
    event: (e: WalletEvent) => onEvent?.(e),
    resync: () => onResync?.(),
  };
}

describe('WalletEventsRelay: de cada aviso de Postgres, a quien lo espera en esta réplica', () => {
  it('«el saldo cambió» → sus páginas abiertas (SSE)', () => {
    const r = makeRelay();
    r.event({ kind: 'wallet', walletId: W });
    expect(r.hub.notify).toHaveBeenCalledWith(W);
    expect(r.gateway.emitWalletChargeUpdate).not.toHaveBeenCalled();
  });

  it('«el cobro del saldo cambió» → la app del personal que lo espera (socket)', () => {
    const r = makeRelay();
    r.event({ kind: 'charge', chargeId: C, status: 'ACCEPTED' });
    expect(r.gateway.emitWalletChargeUpdate).toHaveBeenCalledWith(C, 'ACCEPTED');
    expect(r.hub.notify).not.toHaveBeenCalled();
  });

  it('volvió la escucha tras un corte → todas las páginas se ponen al día', () => {
    const r = makeRelay();
    r.resync();
    expect(r.hub.resync).toHaveBeenCalledTimes(1);
  });

  it('al cerrar el módulo deja de escuchar', () => {
    const r = makeRelay();
    r.relay.onModuleDestroy();
    expect(r.unsubscribe.event).toHaveBeenCalled();
    expect(r.unsubscribe.resync).toHaveBeenCalled();
  });
});
