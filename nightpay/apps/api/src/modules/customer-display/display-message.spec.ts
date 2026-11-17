import { describe, it, expect } from 'vitest';
import { DISPLAY_MESSAGE_MAX, UpdateDisplayMessageSchema } from '@nightpay/contracts';

/** El mensaje del reposo de la «Pantalla del cliente»: una línea y otra opcional, 120 letras cada una. */
describe('mensaje de la pantalla del cliente: lo que se guarda', () => {
  const parse = (v: unknown) => UpdateDisplayMessageSchema.safeParse(v);

  it('una línea y otra opcional, sin espacios de sobra', () => {
    expect(parse({ line1: '  2x1 en copas  ', line2: ' Sábado: fiesta blanca ' }).data).toEqual({
      line1: '2x1 en copas',
      line2: 'Sábado: fiesta blanca',
    });
    expect(parse({ line1: 'Solo una' }).data).toEqual({ line1: 'Solo una', line2: null });
  });

  it('vacío = sin mensaje; la segunda sola pasa a ser la primera', () => {
    expect(parse({ line1: '', line2: '   ' }).data).toEqual({ line1: null, line2: null });
    expect(parse({ line1: null, line2: null }).data).toEqual({ line1: null, line2: null });
    expect(parse({}).data).toEqual({ line1: null, line2: null });
    expect(parse({ line1: ' ', line2: 'Fiesta blanca' }).data).toEqual({ line1: 'Fiesta blanca', line2: null });
  });

  it('cada línea es una línea: los saltos y los caracteres de control, un espacio', () => {
    expect(parse({ line1: 'Copas\n\n2x1\t hoy\u0000' }).data).toEqual({ line1: 'Copas 2x1 hoy', line2: null });
  });

  it('como mucho 120 letras por línea (contadas ya sin espacios de sobra)', () => {
    expect(DISPLAY_MESSAGE_MAX).toBe(120);
    expect(parse({ line1: 'a'.repeat(120) }).success).toBe(true);
    expect(parse({ line1: ` ${'a'.repeat(120)} ` }).success).toBe(true);
    expect(parse({ line1: 'a'.repeat(121) }).success).toBe(false);
    expect(parse({ line1: 'ok', line2: 'b'.repeat(121) }).success).toBe(false);
    expect(parse({ line1: 'x'.repeat(5000) }).success).toBe(false);
  });

  it('un texto pegado de más de 1000 letras: el mismo aviso en español', () => {
    for (const n of [1001, 5000]) {
      expect(parse({ line1: 'x'.repeat(n) }).error?.issues[0]?.message).toBe('Como mucho 120 letras por línea');
    }
  });

  it('solo texto: lo que no es texto no vale; el HTML se guarda tal cual (se escapa al enseñarlo)', () => {
    expect(parse({ line1: 42 }).success).toBe(false);
    expect(parse({ line1: ['a'] }).success).toBe(false);
    expect(parse({ line1: '<b>Hola</b>' }).data).toEqual({ line1: '<b>Hola</b>', line2: null });
  });
});
