import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WALLET_CHARGE_POLL_LIVE_MS,
  WALLET_CHARGE_POLL_OFFLINE_MS,
  WALLET_CHARGE_RECONNECT_MS,
  createWalletChargeLive,
  type ChargeSocket,
} from './wallet-charge-live';

/**
 * El cobro del saldo al momento en la app del personal (H-2): antes se
 * preguntaba al API cada 1–1,5 s; ahora el aviso llega por el tiempo real
 * (wallet-charge:update) y solo entonces se pregunta. De respaldo, cada 10 s
 * con el tiempo real conectado (cada 4 s sin él).
 */

const ID = '7d0f4f9e-0000-4000-8000-000000000101';

type ChargeUpdate = { id?: string; status?: string };

class FakeSocket implements ChargeSocket {
  active = true;
  emitted: Array<[string, unknown]> = [];
  disconnected = false;
  connects = 0;
  private handlers = new Map<string, Array<(e: ChargeUpdate) => void>>();
  on(event: string, fn: (e: ChargeUpdate) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, data: unknown): this {
    this.emitted.push([event, data]);
    return this;
  }
  connect(): this {
    this.connects += 1;
    return this;
  }
  disconnect(): this {
    this.disconnected = true;
    return this;
  }
  fire(event: string, e: ChargeUpdate = {}): void {
    for (const fn of this.handlers.get(event) ?? []) fn(e);
  }
}

function setup(hidden = { on: false }) {
  const socket = new FakeSocket();
  const task = vi.fn(async () => undefined as void);
  const live = createWalletChargeLive({ chargeId: ID, socket: () => socket, poll: task, isHidden: () => hidden.on });
  return { socket, task, live, hidden };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createWalletChargeLive', () => {
  it('al conectar: se apunta a SU cobro y pregunta ya (un pago de antes de conectar no se pierde)', async () => {
    const { socket, task, live } = setup();
    live.start(WALLET_CHARGE_POLL_OFFLINE_MS);
    socket.fire('connect');
    expect(socket.emitted).toEqual([['wallet-charge:subscribe', { chargeId: ID }]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it('el aviso de SU cobro → pregunta al momento; el de otro cobro, no', async () => {
    const { socket, task, live } = setup();
    live.start(WALLET_CHARGE_POLL_OFFLINE_MS);
    socket.fire('connect');
    await vi.advanceTimersByTimeAsync(0);
    task.mockClear();
    socket.fire('wallet-charge:update', { id: '7d0f4f9e-0000-4000-8000-000000000999', status: 'ACCEPTED' });
    await vi.advanceTimersByTimeAsync(0);
    expect(task).not.toHaveBeenCalled();
    socket.fire('wallet-charge:update', { id: ID, status: 'ACCEPTED' });
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it(`de respaldo: cada ${WALLET_CHARGE_POLL_LIVE_MS / 1000} s con el tiempo real; cada ${WALLET_CHARGE_POLL_OFFLINE_MS / 1000} s sin él (antes, cada 1–1,5 s)`, async () => {
    const { socket, task, live } = setup();
    live.start(WALLET_CHARGE_POLL_OFFLINE_MS);
    socket.fire('connect');
    await vi.advanceTimersByTimeAsync(0);
    task.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(6);
    socket.fire('disconnect');
    task.mockClear();
    await vi.advanceTimersByTimeAsync(WALLET_CHARGE_POLL_LIVE_MS + 2_000);
    expect(task.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(WALLET_CHARGE_POLL_LIVE_MS).toBe(10_000);
    live.stop();
  });

  it('el servidor cerró la conexión (socket.io no reintenta solo): vuelve a conectar a los 10 s', async () => {
    const { socket, live } = setup();
    live.start(WALLET_CHARGE_POLL_OFFLINE_MS);
    socket.active = false;
    socket.fire('disconnect');
    await vi.advanceTimersByTimeAsync(WALLET_CHARGE_RECONNECT_MS - 1);
    expect(socket.connects).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.connects).toBe(1);
    live.stop();
  });

  it('con la pantalla oculta no pregunta (salvo al volver: poke)', async () => {
    const hidden = { on: true };
    const { socket, task, live } = setup(hidden);
    live.start(0);
    socket.fire('connect');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).not.toHaveBeenCalled();
    hidden.on = false;
    live.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it('al parar (cobro terminado o pantalla fuera): fuera el socket y el sondeo; nada de reconectar', async () => {
    const { socket, task, live } = setup();
    live.start(WALLET_CHARGE_POLL_OFFLINE_MS);
    live.stop();
    expect(socket.disconnected).toBe(true);
    socket.active = false;
    socket.fire('disconnect');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(task).not.toHaveBeenCalled();
    expect(socket.connects).toBe(0);
  });

  it('el sondeo dice «stop» (ya no está pendiente): no pregunta más', async () => {
    const socket = new FakeSocket();
    const task = vi.fn(async () => 'stop' as const);
    const live = createWalletChargeLive({ chargeId: ID, socket: () => socket, poll: task, isHidden: () => false });
    live.start(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    live.stop();
  });
});
