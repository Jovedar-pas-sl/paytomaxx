import { describe, expect, it } from 'vitest';
import { BANK_SLOW_AFTER_MS, classifyConnection, type ConnectionSignals } from '@nightpay/ui';

const ok: ConnectionSignals = { online: true, serverDown: false, bankWaitingSinceMs: null };
const NOW = 1_000_000;

describe('aviso de conexión: qué pasa, en llano', () => {
  it('todo bien: sin aviso', () => {
    expect(classifyConnection(ok, NOW)).toBeNull();
  });

  it('sin red en el móvil (lo primero: entonces no se sabe nada más)', () => {
    const issue = classifyConnection({ online: false, serverDown: true, bankWaitingSinceMs: 0, orphan: true }, NOW);
    expect(issue?.kind).toBe('offline');
    expect(issue?.title).toBe('Tu móvil no tiene internet');
    expect(issue?.hint).toContain('datáfono');
  });

  it('en el TPV dice «este TPV», no «tu móvil»', () => {
    expect(classifyConnection({ ...ok, online: false }, NOW, 'register')?.title).toBe('Este TPV no tiene internet');
  });

  it('OxioPay no responde (5xx, sin conexión con el API, socket caído)', () => {
    const issue = classifyConnection({ ...ok, serverDown: true, bankWaitingSinceMs: 0 }, NOW);
    expect(issue?.kind).toBe('server');
    expect(issue?.title).toBe('OxioPay no responde, reintentando…');
    expect(issue?.hint).toContain('Si urge, cobra con el datáfono');
  });

  it('el banco tarda: solo pasado el margen esperando la autorización', () => {
    expect(classifyConnection({ ...ok, bankWaitingSinceMs: NOW - BANK_SLOW_AFTER_MS + 1 }, NOW)).toBeNull();
    const issue = classifyConnection({ ...ok, bankWaitingSinceMs: NOW - BANK_SLOW_AFTER_MS }, NOW);
    expect(issue?.kind).toBe('bank');
    expect(issue?.title).toBe('El banco está tardando');
  });

  it('el banco tarda: no anima a cobrar otra vez (cobraría dos veces)', () => {
    const issue = classifyConnection({ ...ok, orphan: true }, NOW);
    expect(issue?.kind).toBe('bank');
    expect(issue?.hint).toMatch(/No cobres otra vez/);
  });
});
