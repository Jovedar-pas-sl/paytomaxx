import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNDO_RESOLVE_MS, createDelayedActions, resolveNoteOk, undoMsLeft, undoSecondsLeft } from './undo-resolve';

// «Resolver» un aviso (B11): se marca de verdad a los 10 s; hasta entonces se
// puede deshacer. Si se cierra el panel antes, se manda en ese momento.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('acciones que esperan por si se deshacen', () => {
  it('se hace a los 10 s, no antes, y una sola vez', () => {
    const q = createDelayedActions();
    const run = vi.fn();
    q.schedule('a', run, UNDO_RESOLVE_MS);
    vi.advanceTimersByTime(UNDO_RESOLVE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_RESOLVE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(0);
  });

  it('«Deshacer» antes de tiempo: no se hace nunca', () => {
    const q = createDelayedActions();
    const run = vi.fn();
    q.schedule('a', run, UNDO_RESOLVE_MS);
    vi.advanceTimersByTime(9_000);
    expect(q.cancel('a')).toBe(true);
    vi.advanceTimersByTime(UNDO_RESOLVE_MS);
    expect(run).not.toHaveBeenCalled();
    // Ya hecha (o ya deshecha): no hay nada que deshacer.
    expect(q.cancel('a')).toBe(false);
  });

  it('deshacer uno no toca los demás', () => {
    const q = createDelayedActions();
    const a = vi.fn();
    const b = vi.fn();
    q.schedule('a', a, UNDO_RESOLVE_MS);
    q.schedule('b', b, UNDO_RESOLVE_MS);
    q.cancel('a');
    vi.advanceTimersByTime(UNDO_RESOLVE_MS);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('volver a marcar el mismo aviso empieza la cuenta de nuevo y se hace una vez', () => {
    const q = createDelayedActions();
    const first = vi.fn();
    const second = vi.fn();
    q.schedule('a', first, UNDO_RESOLVE_MS);
    vi.advanceTimersByTime(5_000);
    q.schedule('a', second, UNDO_RESOLVE_MS);
    vi.advanceTimersByTime(5_000);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('al cerrar el panel se hace ya lo que esperaba (y no otra vez después)', () => {
    const q = createDelayedActions();
    const a = vi.fn();
    const b = vi.fn();
    q.schedule('a', a, UNDO_RESOLVE_MS);
    q.schedule('b', b, UNDO_RESOLVE_MS);
    q.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_RESOLVE_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(0);
  });
});

describe('cuenta atrás', () => {
  it('10 s al empezar, nunca 0 mientras se puede deshacer', () => {
    expect(undoSecondsLeft(10_000, 0)).toBe(10);
    expect(undoSecondsLeft(10_000, 9_001)).toBe(1);
    expect(undoSecondsLeft(10_000, 10_000)).toBe(0);
    expect(undoSecondsLeft(10_000, 12_000)).toBe(0);
  });
});

describe('barra de «Deshacer»', () => {
  it('milisegundos que quedan, nunca negativos (la barra se vacía en UNDO_RESOLVE_MS)', () => {
    expect(undoMsLeft(UNDO_RESOLVE_MS, 0)).toBe(10_000);
    expect(undoMsLeft(UNDO_RESOLVE_MS, 2_500)).toBe(7_500);
    expect(undoMsLeft(UNDO_RESOLVE_MS, 12_000)).toBe(0);
  });
});

describe('nota de un aviso de dinero', () => {
  it('obligatoria (3 letras como mínimo, como el API) solo si el aviso la pide', () => {
    expect(resolveNoteOk(true, '')).toBe(false);
    expect(resolveNoteOk(true, '  ok  ')).toBe(false);
    expect(resolveNoteOk(true, 'devuelto')).toBe(true);
    expect(resolveNoteOk(false, '')).toBe(true);
  });
});
