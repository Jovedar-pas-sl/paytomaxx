import { describe, expect, it } from 'vitest';
import { ClientErrorSchema } from './client-errors.controller';

describe('POST /v1/client-errors: lo que se acepta', () => {
  const ok = { app: 'operator', message: 'boom' };

  it('acepta lo que manda la pantalla de fallo', () => {
    expect(ClientErrorSchema.safeParse({ ...ok, digest: '1234567890', path: '/w/abc%20d', build: 'v1.2.3+abc' }).success).toBe(true);
  });

  it('rechaza rutas que no son una ruta: un enlace, saltos de línea o espacios', () => {
    expect(ClientErrorSchema.safeParse({ ...ok, path: 'http://evil.tld/x' }).success).toBe(false);
    expect(ClientErrorSchema.safeParse({ ...ok, path: '/x\nERROR Pago aprobado' }).success).toBe(false);
    expect(ClientErrorSchema.safeParse({ ...ok, path: '/x y' }).success).toBe(false);
  });

  it('la huella y el build, solo letras, cifras y . _ + -', () => {
    expect(ClientErrorSchema.safeParse({ ...ok, build: 'v1\nERROR' }).success).toBe(false);
    expect(ClientErrorSchema.safeParse({ ...ok, digest: '<b>' }).success).toBe(false);
    expect(ClientErrorSchema.safeParse({ ...ok, app: 'otra' }).success).toBe(false);
  });
});
