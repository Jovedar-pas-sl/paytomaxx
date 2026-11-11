import { beforeEach, describe, expect, it } from 'vitest';
import {
  bubblePlacement,
  closeMarksSeen,
  hasSeenTour,
  markTourSeen,
  presentSteps,
  resetTourSession,
  shouldAutoStart,
  stepCounter,
  tourKey,
  tourMove,
  type TourStorage,
  type TourStep,
} from './tour';

function fakeStorage(initial: Record<string, string> = {}): TourStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

const steps: TourStep[] = [
  { target: 'a', title: 'A', text: 'a' },
  { target: 'b', title: 'B', text: 'b' },
  { target: 'c', title: 'C', text: 'c' },
];

beforeEach(() => resetTourSession());

describe('tourKey', () => {
  it('lleva la pantalla y la versión', () => {
    expect(tourKey('cobrar')).toBe('np-tour-cobrar-v1');
  });
});

describe('visto', () => {
  it('la primera vez no está visto y al marcarlo sí', () => {
    const s = fakeStorage();
    expect(hasSeenTour('cobrar', s)).toBe(false);
    markTourSeen('cobrar', s);
    expect(s.data['np-tour-cobrar-v1']).toBe('1');
    expect(hasSeenTour('cobrar', s)).toBe(true);
  });
  it('cada pantalla tiene lo suyo', () => {
    const s = fakeStorage();
    markTourSeen('cobrar', s);
    expect(hasSeenTour('cuenta', s)).toBe(false);
  });
  it('si el almacenamiento falla al leer, se da por visto (no insiste)', () => {
    const broken: TourStorage = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(hasSeenTour('cobrar', broken)).toBe(true);
  });
  it('si falla al escribir, no revienta y queda visto en la sesión', () => {
    const broken: TourStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('lleno');
      },
    };
    expect(() => markTourSeen('cobrar', broken)).not.toThrow();
    expect(hasSeenTour('cobrar', fakeStorage())).toBe(true);
  });
  it('sin almacenamiento, no sale solo', () => {
    expect(hasSeenTour('cobrar', null)).toBe(true);
  });
});

describe('presentSteps', () => {
  it('salta los pasos cuyo elemento no está', () => {
    const here = new Set(['a', 'c']);
    const out = presentSteps(steps, (t) => (here.has(t) ? t : null));
    expect(out.map((p) => p.step.target)).toEqual(['a', 'c']);
  });
});

describe('tourMove', () => {
  it('avanza, retrocede y termina al pasar del último', () => {
    expect(tourMove(0, 3, 'next')).toEqual({ index: 1 });
    expect(tourMove(2, 3, 'prev')).toEqual({ index: 1 });
    expect(tourMove(2, 3, 'next')).toBe('done');
    expect(tourMove(0, 3, 'prev')).toEqual({ index: 0 });
  });
});

describe('shouldAutoStart / closeMarksSeen / stepCounter', () => {
  const free = { seen: false, ready: true, modalOpen: false, tourOpen: false };
  it('sale solo la primera vez y con la pantalla libre', () => {
    expect(shouldAutoStart(free)).toBe(true);
    expect(shouldAutoStart({ ...free, seen: true })).toBe(false);
    expect(shouldAutoStart({ ...free, ready: false })).toBe(false);
    expect(shouldAutoStart({ ...free, modalOpen: true })).toBe(false);
    expect(shouldAutoStart({ ...free, tourOpen: true })).toBe(false);
  });
  it('terminar, saltar o Escape lo dejan visto; no haber nada que enseñar, no', () => {
    expect(closeMarksSeen('done')).toBe(true);
    expect(closeMarksSeen('skip')).toBe(true);
    expect(closeMarksSeen('escape')).toBe(true);
    expect(closeMarksSeen('empty')).toBe(false);
  });
  it('cuenta «1 de 4»', () => {
    expect(stepCounter(0, 4)).toBe('1 de 4');
  });
});

describe('bubblePlacement', () => {
  const base = { viewportHeight: 800, bubbleHeight: 200, gap: 12 };
  it('debajo si cabe, encima si no, y si no cabe en ningún lado, donde hay más sitio', () => {
    expect(bubblePlacement({ ...base, targetTop: 100, targetBottom: 200 })).toBe('below');
    expect(bubblePlacement({ ...base, targetTop: 600, targetBottom: 700 })).toBe('above');
    expect(bubblePlacement({ ...base, targetTop: 100, targetBottom: 650 })).toBe('bottom');
    expect(bubblePlacement({ ...base, targetTop: 150, targetBottom: 700 })).toBe('top');
  });
});
