import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { WEBHOOK_GATE_TTL_MS, WebhookProviderGate, bootLine } from './webhook-provider-gate';

const NOW = new Date('2026-10-23T01:00:00Z');

/** Las credenciales activas que devuelve la base (por pasarela, sin repetir). */
function makeGate(rows: Array<{ provider: string }> | Error) {
  const findMany = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const tx = { gatewayCredential: { findMany } };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { gate: new WebhookProviderGate(prisma as never), prisma, findMany };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('qué avisos de pasarela se atienden', () => {
  it('abierto solo si algún local tiene una credencial ACTIVA de esa pasarela (sin RLS: asSystem)', async () => {
    const { gate, prisma, findMany } = makeGate([{ provider: 'PEANPE' }]);
    expect(await gate.enabled('PEANPE')).toBe(true);
    expect(await gate.enabled('PAYTEF')).toBe(false);
    expect(prisma.asSystem).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { active: true, provider: { in: ['PAYTEF', 'PEANPE'] } },
      distinct: ['provider'],
      select: { provider: true },
    });
  });

  it('un aluvión de avisos no hace una consulta por petición: una a la vez y vale 30 s', async () => {
    const { gate, findMany } = makeGate([]);
    const answers = await Promise.all(Array.from({ length: 20 }, () => gate.enabled('PAYTEF')));
    expect(answers.every((a) => a === false)).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(1);
    vi.setSystemTime(NOW.getTime() + WEBHOOK_GATE_TTL_MS - 1);
    await gate.enabled('PEANPE');
    expect(findMany).toHaveBeenCalledTimes(1);
    // Pasado el plazo se vuelve a mirar: un local que empieza a usarla la tiene abierta.
    findMany.mockResolvedValueOnce([{ provider: 'PAYTEF' }]);
    vi.setSystemTime(NOW.getTime() + WEBHOOK_GATE_TTL_MS);
    expect(await gate.enabled('PAYTEF')).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('si la base falla, el aviso falla (no se abre a ciegas) y la siguiente vez se vuelve a mirar', async () => {
    const { gate, findMany } = makeGate(new Error('base caída'));
    await expect(gate.enabled('PAYTEF')).rejects.toThrow('base caída');
    findMany.mockResolvedValueOnce([{ provider: 'PAYTEF' }]);
    expect(await gate.enabled('PAYTEF')).toBe(true);
  });

  it('al arrancar lo dice una vez en el registro; si la base no contesta, avisa y arranca igual', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await makeGate([{ provider: 'PEANPE' }]).gate.onApplicationBootstrap();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe(
      'Avisos de pasarelas: abiertos PEANPE; cerrados PAYTEF (404: ningún local tiene credencial activa). REDSYS y WIPAY, siempre abiertos.',
    );
    await expect(makeGate(new Error('base caída')).gate.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/base caída/));
  });

  it('la línea del arranque: todas abiertas o todas cerradas', () => {
    expect(bootLine(new Set(['PAYTEF', 'PEANPE']))).toBe('Avisos de pasarelas: abiertos PAYTEF, PEANPE. REDSYS y WIPAY, siempre abiertos.');
    expect(bootLine(new Set(['REDSYS']))).toBe(
      'Avisos de pasarelas: cerrados PAYTEF, PEANPE (404: ningún local tiene credencial activa). REDSYS y WIPAY, siempre abiertos.',
    );
  });
});
