import { afterAll, describe, expect, it } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { bcryptCompare, bcryptHash, stopPasswordWorkers } from './password-hash';

/**
 * La contraseña (bcrypt, ~80 ms de CPU en JS puro) se calcula en otro hilo:
 * en el del API paraba todas las peticiones mientras tanto (carga del
 * 19-11-2026: 21 entradas al turno a la vez, 3 s cada una). Los hashes son
 * los de siempre: los que hay en la base siguen valiendo.
 */
describe('contraseñas en otro hilo', () => {
  afterAll(async () => {
    await stopPasswordWorkers();
  });

  it('los hashes de siempre siguen valiendo, y los nuevos valen con bcryptjs', async () => {
    const stored = bcrypt.hashSync('Turno-de-noche-1', 10);
    await expect(bcryptCompare('Turno-de-noche-1', stored)).resolves.toBe(true);
    await expect(bcryptCompare('turno-de-noche-1', stored)).resolves.toBe(false);

    const fresh = await bcryptHash('Barra-2026', 10);
    expect(fresh).toMatch(/^\$2[ab]\$10\$.{53}$/);
    expect(bcrypt.compareSync('Barra-2026', fresh)).toBe(true);
    expect(bcrypt.compareSync('Barra-2025', fresh)).toBe(false);
  });

  it('un hash que no es de bcrypt: false, sin romper el hilo (el siguiente sigue funcionando)', async () => {
    await expect(bcryptCompare('x', 'no-es-un-hash')).resolves.toBe(false);
    await expect(bcryptCompare('Barra-2026', await bcryptHash('Barra-2026', 4))).resolves.toBe(true);
  });

  it('mientras se calculan varias, el API sigue atendiendo (el bucle de eventos no se para)', async () => {
    const stored = bcrypt.hashSync('Entrada-turno', 12);
    const started = performance.now();
    const all = Promise.all(Array.from({ length: 4 }, () => bcryptCompare('Entrada-turno', stored)));
    // Otra petición que llega justo después: no espera a ninguna contraseña.
    const waited = await new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 0));
    expect(waited).toBeLessThan(50);
    await expect(all).resolves.toEqual([true, true, true, true]);
  });
});
