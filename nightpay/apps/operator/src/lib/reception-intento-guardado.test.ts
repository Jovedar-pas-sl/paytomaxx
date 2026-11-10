import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CASH_ATTEMPT_STORAGE_KEY,
  CASH_ATTEMPT_TTL_MS,
  cashAttemptRef,
  loadCashAttempt,
  receptionAttempt,
  saveCashAttempt,
  type AttemptStorage,
} from './reception';

// Auditoría S-4: si la pantalla de recepción falla a mitad de una recarga en
// efectivo («Esta pantalla ha fallado» → «Volver a cobrar» recarga la app),
// la clave de la recarga se perdía y, al repetirla, el efectivo se cargaba dos
// veces. Ahora queda en sessionStorage un rato y repetir lo mismo va con la
// misma clave. Y la pantalla de fallo dice qué mirar antes de cobrar o cargar.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function memoryStorage(): AttemptStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const CASH = '5000|cash|ficha:tok-1';
const CARD = '5000|card|ficha:tok-1';

describe('la recarga en efectivo a medias, en la pestaña', () => {
  it('tras un fallo y volver a entrar, la misma recarga va con la misma clave (no se carga dos veces)', () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const before = cashAttemptRef(storage, () => now);
    before.current = receptionAttempt(before.current, CASH);
    const key = before.current.key;
    // La pantalla falla y la app se recarga: un ref nuevo empieza con lo guardado.
    now += 60_000;
    const after = cashAttemptRef(storage, () => now);
    expect(after.current?.key).toBe(key);
    expect(receptionAttempt(after.current, CASH).key).toBe(key);
    // Otra recarga (otro importe) ya no reutiliza la clave.
    expect(receptionAttempt(after.current, '2000|cash|ficha:tok-1').key).not.toBe(key);
  });

  it('al terminar (o al pasar al siguiente cliente) se borra', () => {
    const storage = memoryStorage();
    const ref = cashAttemptRef(storage, () => 1);
    ref.current = receptionAttempt(null, CASH);
    expect(storage.data.has(CASH_ATTEMPT_STORAGE_KEY)).toBe(true);
    ref.current = null;
    expect(storage.data.has(CASH_ATTEMPT_STORAGE_KEY)).toBe(false);
  });

  it('solo la de efectivo: la de tarjeta no se guarda (y quita la de efectivo que hubiera)', () => {
    const storage = memoryStorage();
    const ref = cashAttemptRef(storage, () => 1);
    ref.current = receptionAttempt(null, CASH);
    ref.current = receptionAttempt(ref.current, CARD);
    expect(storage.data.has(CASH_ATTEMPT_STORAGE_KEY)).toBe(false);
  });

  it('pasado un rato, lo guardado ya no es la misma recarga', () => {
    const storage = memoryStorage();
    saveCashAttempt(storage, { key: 'rec-1', what: CASH }, 0);
    expect(loadCashAttempt(storage, CASH_ATTEMPT_TTL_MS)).toEqual({ key: 'rec-1', what: CASH });
    expect(loadCashAttempt(storage, CASH_ATTEMPT_TTL_MS + 1)).toBeNull();
    expect(CASH_ATTEMPT_TTL_MS).toBe(10 * 60_000);
  });

  it('si el almacenamiento falla o trae otra cosa, como antes: sin clave guardada y sin romperse', () => {
    const broken: AttemptStorage = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('lleno');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    };
    expect(loadCashAttempt(broken, 1)).toBeNull();
    expect(() => saveCashAttempt(broken, { key: 'k', what: CASH }, 1)).not.toThrow();
    const ref = cashAttemptRef(broken, () => 1);
    ref.current = { key: 'k', what: CASH };
    expect(ref.current.key).toBe('k');
    const junk = memoryStorage();
    junk.setItem(CASH_ATTEMPT_STORAGE_KEY, '{no es json');
    expect(loadCashAttempt(junk, 1)).toBeNull();
    junk.setItem(CASH_ATTEMPT_STORAGE_KEY, JSON.stringify({ key: 5, what: CASH, at: 1 }));
    expect(loadCashAttempt(junk, 1)).toBeNull();
    expect(loadCashAttempt(null, 1)).toBeNull();
  });

  it('recepción usa la clave guardada', () => {
    const desk = read('../components/reception/desk/ReceptionDesk.tsx');
    expect(desk).toContain('const attempt = useCashAttemptRef();');
    expect(desk).toContain('cashAttemptRef(browserSessionStorage())');
    expect(desk).not.toMatch(/useRef<ReceptionAttempt \| null>\(null\)/);
  });
});

describe('la pantalla de fallo', () => {
  const TEXT = 'Si había un cobro o una recarga a medias, sigue en el servidor: mira Cobros o acerca la ficha antes de cobrar o cargar otra vez.';

  it('dice qué mirar antes de cobrar o cargar otra vez (la de la pantalla y la de toda la app)', () => {
    expect(read('../app/error.tsx')).toContain(`detail="${TEXT}"`);
    expect(read('../app/global-error.tsx')).toContain(`detail="${TEXT}"`);
  });
});
