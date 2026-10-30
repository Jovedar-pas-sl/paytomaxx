import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAM_HEARTBEAT_MS,
  STREAM_MAX_PER_IP,
  STREAM_MAX_PER_WALLET,
  WalletStreamHub,
  type WalletStreamSink,
} from './wallet-stream.hub';

const W1 = '3f6c2a1e-8b4d-4c7e-9a10-5d2e7f8a9b01';
const W2 = 'b7e1d2c3-0000-4000-8000-00000000beef';

/** Lo que recibe el navegador por una conexión. */
function sink(): WalletStreamSink & { chunks: string[]; ended: boolean; events: () => Array<{ event: string; data: unknown }> } {
  const s = {
    chunks: [] as string[],
    ended: false,
    write(chunk: string) {
      s.chunks.push(chunk);
      return true;
    },
    end() {
      s.ended = true;
    },
    events() {
      return s.chunks
        .join('')
        .split('\n\n')
        .filter((block) => block.includes('event: '))
        .map((block) => {
          const event = /event: (.*)/.exec(block)?.[1] ?? '';
          const data = /data: (.*)/.exec(block)?.[1];
          return { event, data: data ? (JSON.parse(data) as unknown) : null };
        });
    },
  };
  return s;
}

const NOW = Date.parse('2026-10-29T23:00:00Z');
const later = (ms: number) => NOW + ms;

let hub: WalletStreamHub;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  hub = new WalletStreamHub();
});
afterEach(() => {
  hub.onModuleDestroy();
  vi.useRealTimers();
});

describe('WalletStreamHub: las páginas del saldo abiertas en esta réplica', () => {
  it('al abrir: «hola» (con el reintento sugerido) y queda apuntada a su saldo', () => {
    const s = sink();
    expect(hub.open({ walletId: W1, ip: '1.2.3.4', closeAt: later(60_000), sink: s }).ok).toBe(true);
    const text = s.chunks.join('');
    expect(text.startsWith('retry: ')).toBe(true);
    expect(s.events()).toEqual([{ event: 'hello', data: { at: NOW } }]);
    expect(hub.size).toBe(1);
  });

  it('un aviso de un saldo va solo a las páginas de ESE saldo, sin datos: «cambió» y la hora', () => {
    const a = sink();
    const b = sink();
    hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(60_000), sink: a });
    hub.open({ walletId: W2, ip: '1.1.1.1', closeAt: later(60_000), sink: b });
    hub.notify(W1);
    expect(a.events().map((e) => e.event)).toEqual(['hello', 'change']);
    expect(a.events()[1]!.data).toEqual({ at: NOW });
    expect(b.events().map((e) => e.event)).toEqual(['hello']);
    // Ni saldo, ni código, ni enlace.
    expect(a.chunks.join('')).not.toMatch(/balance|code|token|cents/i);
  });

  it('latido cada ~20 s (un comentario): Cloudflare corta a los 100 s sin bytes', () => {
    const s = sink();
    hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(10 * 60_000), sink: s });
    vi.advanceTimersByTime(STREAM_HEARTBEAT_MS);
    expect(s.chunks.at(-1)).toBe(': ♥\n\n');
    vi.advanceTimersByTime(STREAM_HEARTBEAT_MS * 4);
    expect(s.chunks.filter((c) => c.startsWith(':')).length).toBe(5);
    expect(STREAM_HEARTBEAT_MS).toBeLessThanOrEqual(25_000);
  });

  it('al llegar su hora (la sesión caduca o el tope de vida) se despide y se cierra: la página vuelve a entrar con su cookie', () => {
    const s = sink();
    hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(30_000), sink: s });
    vi.advanceTimersByTime(STREAM_HEARTBEAT_MS * 2);
    expect(s.events().at(-1)).toEqual({ event: 'bye', data: { r: 'renew' } });
    expect(s.ended).toBe(true);
    expect(hub.size).toBe(0);
  });

  it(`tope por saldo (${STREAM_MAX_PER_WALLET}): la más vieja se despide («cap»: no vuelve, sigue con el sondeo)`, () => {
    const sinks = Array.from({ length: STREAM_MAX_PER_WALLET + 1 }, () => sink());
    sinks.forEach((s, i) => {
      vi.setSystemTime(later(i));
      expect(hub.open({ walletId: W1, ip: `10.0.0.${i}`, closeAt: later(60_000), sink: s }).ok).toBe(true);
    });
    expect(sinks[0]!.events().at(-1)).toEqual({ event: 'bye', data: { r: 'cap' } });
    expect(sinks[0]!.ended).toBe(true);
    expect(sinks.slice(1).every((s) => !s.ended)).toBe(true);
    expect(hub.size).toBe(STREAM_MAX_PER_WALLET);
  });

  it(`tope por IP (${STREAM_MAX_PER_IP}, el wifi del local es una sola IP): la de más no se abre`, () => {
    for (let i = 0; i < STREAM_MAX_PER_IP; i += 1) {
      hub.open({ walletId: `${W1.slice(0, -4)}${String(i).padStart(4, '0')}`, ip: '9.9.9.9', closeAt: later(60_000), sink: sink() });
    }
    expect(hub.canOpen('9.9.9.9')).toBe(false);
    expect(hub.open({ walletId: W2, ip: '9.9.9.9', closeAt: later(60_000), sink: sink() })).toEqual({ ok: false, reason: 'ip-limit' });
    expect(hub.canOpen('8.8.8.8')).toBe(true);
  });

  it('cerrar (el navegador se fue) la quita una vez; repetirlo no descuenta de más', () => {
    const s = sink();
    const opened = hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(60_000), sink: s });
    if (!opened.ok) throw new Error('no abrió');
    hub.close(opened.stream);
    hub.close(opened.stream);
    expect(hub.size).toBe(0);
    hub.notify(W1);
    expect(s.events().map((e) => e.event)).toEqual(['hello']);
    expect(hub.canOpen('1.1.1.1')).toBe(true);
  });

  it('volvió la escucha tras un corte: «ponte al día» a todas (cada página espera un poco al azar)', () => {
    const a = sink();
    const b = sink();
    hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(60_000), sink: a });
    hub.open({ walletId: W2, ip: '1.1.1.1', closeAt: later(60_000), sink: b });
    hub.resync();
    expect(a.events().at(-1)!.event).toBe('resync');
    expect(b.events().at(-1)!.event).toBe('resync');
  });

  it('una conexión que ya no acepta bytes se quita sin romper a las demás', () => {
    const broken = sink();
    broken.write = () => {
      throw new Error('write after end');
    };
    const ok = sink();
    hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(60_000), sink: broken });
    hub.open({ walletId: W1, ip: '1.1.1.2', closeAt: later(60_000), sink: ok });
    hub.notify(W1);
    expect(hub.size).toBe(1);
    expect(ok.events().map((e) => e.event)).toEqual(['hello', 'change']);
  });

  it('al apagar la réplica: «adiós, vuelve» a todas y no se abren más (la nueva las recibe)', () => {
    const s = sink();
    hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(60_000), sink: s });
    hub.closeAll();
    expect(s.events().at(-1)).toEqual({ event: 'bye', data: { r: 'restart' } });
    expect(s.ended).toBe(true);
    expect(hub.size).toBe(0);
    expect(hub.open({ walletId: W1, ip: '1.1.1.1', closeAt: later(60_000), sink: sink() })).toEqual({ ok: false, reason: 'closing' });
  });
});
