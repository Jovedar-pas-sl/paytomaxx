import { describe, expect, it } from 'vitest';
import { primerosPasos, primerosPasosKey, primerosPasosFormasKey, type PrimerosPasosDatos } from './primeros-pasos';

// Primeros pasos (entrega 10 A, idea 23): la tarjeta del dueño sobre «Resumen».

const NUEVO: PrimerosPasosDatos = { carta: 0, companeras: 0, camareros: 0, formasVistas: false, dosPasos: false, noches: 0 };

describe('Primeros pasos', () => {
  it('cinco pasos, en orden, con su destino; «2 de 5»', () => {
    const v = primerosPasos({ ...NUEVO, carta: 4, dosPasos: true });
    expect(v.visible).toBe(true);
    expect(v.texto).toBe('2 de 5');
    expect(v.pasos.map((p) => [p.label, p.done, p.tab])).toEqual([
      ['Pon tu carta', true, 'carta'],
      ['Da de alta a tu equipo', false, 'operators'],
      ['Revisa cómo cobras', false, 'methods'],
      ['Activa la verificación en dos pasos', true, 'security'],
      ['Abre tu primera noche', false, 'nights'],
    ]);
  });

  it('cuentan los camareros: un local con solo camareros ya tiene equipo', () => {
    expect(primerosPasos({ ...NUEVO, camareros: 1 }).pasos[1]!.done).toBe(true);
    expect(primerosPasos({ ...NUEVO, companeras: 2 }).pasos[1]!.done).toBe(true);
  });

  it('con 3 noches no sale (el local ya está en marcha)', () => {
    expect(primerosPasos({ ...NUEVO, noches: 2 }).visible).toBe(true);
    expect(primerosPasos({ ...NUEVO, noches: 3 }).visible).toBe(false);
  });

  it('no sale hasta saber los cinco datos, ni si alguno falla, ni si se ocultó', () => {
    expect(primerosPasos(null).visible).toBe(false);
    expect(primerosPasos(NUEVO, { oculto: true }).visible).toBe(false);
  });

  it('a 5 de 5, completo (el aviso «Tu local está listo», una vez, y se oculta)', () => {
    const v = primerosPasos({ carta: 1, companeras: 1, camareros: 0, formasVistas: true, dosPasos: true, noches: 1 });
    expect(v.texto).toBe('5 de 5');
    expect(v.completo).toBe(true);
  });

  it('las marcas del navegador, por local', () => {
    expect(primerosPasosKey('t1')).toBe('np-primeros-pasos:t1');
    expect(primerosPasosFormasKey('t1')).toBe('np-primeros-pasos-formas:t1');
  });
});
