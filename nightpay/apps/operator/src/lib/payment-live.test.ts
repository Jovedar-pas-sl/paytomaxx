import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPaymentLive,
  PAYMENT_POLL_LIVE_MS,
  PAYMENT_POLL_OFFLINE_MS,
  PAYMENT_POLL_TIMEOUT_MS,
  PAYMENT_RECONNECT_AFTER_SERVER_CLOSE_MS,
  PAYMENT_RECONNECT_MS,
  type PaymentSocket,
} from '@nightpay/ui';

/**
 * Cuándo se pregunta al API por un cobro mientras el personal espera el
 * «PAGADO» (operadora y TPV comparten esta lógica): la cobertura del local es
 * mala, así que se pregunta pronto al conectar, al caerse, al volver la red y
 * al confirmar la suscripción.
 */

type Ack = (res?: { ok?: boolean }) => void;

class FakeSocket implements PaymentSocket {
  active = true;
  disconnected = false;
  connects = 0;
  subscribes: Array<{ paymentId: string; ack: Ack }> = [];
  private handlers = new Map<string, Array<(arg?: string) => void>>();
  on(event: string, fn: (arg?: string) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(_event: 'payment:subscribe', data: { paymentId: string }, ack: Ack): this {
    this.subscribes.push({ paymentId: data.paymentId, ack });
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
  fire(event: string, arg?: string): void {
    for (const fn of this.handlers.get(event) ?? []) fn(arg);
  }
}

function setup(pollImpl?: () => Promise<void | 'stop' | 'slow'>) {
  const socket = new FakeSocket();
  const poll = vi.fn(pollImpl ?? (async () => undefined));
  const liveChanges: boolean[] = [];
  const link = createPaymentLive({
    paymentId: 'pay-1',
    socket: () => socket,
    poll,
    onLiveChange: (v) => liveChanges.push(v),
  });
  return { socket, poll, liveChanges, link };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPaymentLive', () => {
  it('constantes: sondeo de respaldo cada 10 s con tiempo real, 4 s sin él, plazo de 6 s', () => {
    expect(PAYMENT_POLL_LIVE_MS).toBe(10_000);
    expect(PAYMENT_POLL_OFFLINE_MS).toBe(4_000);
    expect(PAYMENT_POLL_TIMEOUT_MS).toBe(6_000);
  });

  it('al conectar: se apunta a SU cobro, avisa de que hay tiempo real y pregunta ya', async () => {
    const { socket, poll, liveChanges, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    expect(socket.subscribes.map((s) => s.paymentId)).toEqual(['pay-1']);
    expect(liveChanges).toEqual([true]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('al confirmar el servidor la suscripción, pregunta otra vez (lo anterior a entrar en la sala no llegó)', async () => {
    const { socket, poll, liveChanges, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    poll.mockClear();
    socket.subscribes[0]!.ack({ ok: true });
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(liveChanges).toEqual([true]);
  });

  it('si el servidor rechaza la suscripción, cuenta como sin tiempo real, pregunta ya y luego cada 4 s', async () => {
    const { socket, poll, liveChanges, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    poll.mockClear();
    socket.subscribes[0]!.ack({ ok: false });
    await tick(0);
    expect(liveChanges).toEqual([true, false]);
    expect(poll).toHaveBeenCalledTimes(1);
    poll.mockClear();
    await tick(PAYMENT_POLL_OFFLINE_MS);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('al caerse el socket estando conectado: pregunta ya y luego cada 4 s', async () => {
    const { socket, poll, liveChanges, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    poll.mockClear();
    socket.fire('disconnect', 'ping timeout');
    await tick(0);
    expect(liveChanges).toEqual([true, false]);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(PAYMENT_POLL_OFFLINE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('un fallo de conexión sin haber estado conectado no dispara una consulta extra', async () => {
    const { socket, poll, link } = setup();
    link.start(60_000);
    socket.fire('connect_error');
    await tick(0);
    expect(poll).not.toHaveBeenCalled();
  });

  it('con tiempo real, el sondeo de respaldo es cada 10 s (antes 15 s)', async () => {
    const { socket, poll, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    poll.mockClear();
    await tick(PAYMENT_POLL_LIVE_MS - 1);
    expect(poll).not.toHaveBeenCalled();
    await tick(1);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('tras una consulta fallida vuelve a preguntar a los 4 s, no a los 12 s ni a los 30 s', async () => {
    let calls = 0;
    const { poll, link } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('sin respuesta');
    });
    link.start(0);
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(PAYMENT_POLL_OFFLINE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('una consulta colgada se da por perdida a los 6 s y se vuelve a preguntar a los 4 s', async () => {
    let calls = 0;
    const { poll, link } = setup(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls > 1) resolve(undefined);
        }),
    );
    link.start(0);
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(PAYMENT_POLL_TIMEOUT_MS - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await tick(1 + PAYMENT_POLL_OFFLINE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('el servidor cierra la conexión (despliegue): reconecta al segundo, no a los 10 s', async () => {
    const { socket, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    socket.active = false;
    socket.fire('disconnect', 'io server disconnect');
    await tick(PAYMENT_RECONNECT_AFTER_SERVER_CLOSE_MS - 1);
    expect(socket.connects).toBe(0);
    await tick(1);
    expect(socket.connects).toBe(1);
  });

  it('el servidor rechaza la conexión (sesión caducada): reintenta a los 10 s', async () => {
    const { socket, link } = setup();
    link.start(60_000);
    socket.active = false;
    socket.fire('connect_error');
    await tick(PAYMENT_RECONNECT_MS - 1);
    expect(socket.connects).toBe(0);
    await tick(1);
    expect(socket.connects).toBe(1);
  });

  it('si socket.io reconecta solo (active), no se fuerza otra conexión', async () => {
    const { socket, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    socket.fire('disconnect', 'transport close');
    await tick(PAYMENT_RECONNECT_MS * 2);
    expect(socket.connects).toBe(0);
  });

  it('poke() pregunta ya (evento online del navegador, pantalla que vuelve a verse)', async () => {
    const { socket, poll, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    poll.mockClear();
    link.poke();
    await tick(0);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('stop(): cierra el socket y no queda nada programado', async () => {
    const { socket, poll, link } = setup();
    link.start(60_000);
    socket.fire('connect');
    await tick(0);
    socket.active = false;
    socket.fire('disconnect', 'io server disconnect');
    link.stop();
    poll.mockClear();
    await tick(60_000);
    expect(socket.disconnected).toBe(true);
    expect(socket.connects).toBe(0);
    expect(poll).not.toHaveBeenCalled();
  });
});
