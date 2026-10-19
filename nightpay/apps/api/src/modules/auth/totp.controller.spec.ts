import { describe, expect, it, vi } from 'vitest';
import { RequestMethod, UnauthorizedException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { TotpController } from './totp.controller';

const user = {
  sub: '00000000-0000-4000-8000-000000000001',
  email: 'dueno@local.es',
  role: 'OWNER' as const,
  tenantId: '00000000-0000-4000-8000-0000000000aa',
  venueSlug: 'luna',
  sid: 'fam-1',
};
// Conexión directa (sin proxy): la IP es la del socket (clientIp, common/http/client-ip).
const req = { headers: { 'user-agent': 'x'.repeat(2000) }, socket: { remoteAddress: '203.0.113.7' } };

function makeController() {
  const enrollment = {
    status: vi.fn().mockResolvedValue({ enabled: false }),
    setup: vi.fn().mockResolvedValue({ otpauthUrl: 'otpauth://x', secret: 'S', qrPngDataUrl: 'data:' }),
    confirm: vi.fn().mockResolvedValue({ enabled: true }),
    disable: vi.fn().mockResolvedValue({ enabled: false }),
  };
  return { ctrl: new TotpController(enrollment as never), enrollment };
}

function route(handler: keyof TotpController) {
  const fn = TotpController.prototype[handler];
  return {
    path: Reflect.getMetadata(PATH_METADATA, fn) as string,
    method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
    httpCode: Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined,
    isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, fn) as boolean | undefined,
  };
}

describe('TotpController — contrato de rutas (/v1/auth/totp…)', () => {
  it('rutas exactas, todas con sesión (ninguna pública)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TotpController)).toBe('auth/totp');
    expect(route('status')).toMatchObject({ path: '/', method: RequestMethod.GET });
    expect(route('setup')).toMatchObject({ path: 'setup', method: RequestMethod.POST, httpCode: 200 });
    expect(route('confirm')).toMatchObject({ path: 'confirm', method: RequestMethod.POST, httpCode: 200 });
    expect(route('disable')).toMatchObject({ path: 'disable', method: RequestMethod.POST, httpCode: 200 });
    for (const h of ['status', 'setup', 'confirm', 'disable'] as const) expect(route(h).isPublic).toBeUndefined();
  });
});

describe('TotpController — delega en el servicio con el usuario del token', () => {
  it('status / setup', async () => {
    const { ctrl, enrollment } = makeController();
    await expect(ctrl.status(user)).resolves.toEqual({ enabled: false });
    await ctrl.setup(user, { password: 'Clave-1' });
    expect(enrollment.status).toHaveBeenCalledWith(user.sub);
    // La contraseña y la sesión (sid): solo la misma sesión vuelve a ver el secreto pendiente.
    expect(enrollment.setup).toHaveBeenCalledWith(user.sub, 'Clave-1', 'fam-1');
  });

  it('confirm / disable pasan código (y contraseña al confirmar), IP y user-agent recortado', async () => {
    const { ctrl, enrollment } = makeController();
    await expect(ctrl.confirm(user, { code: '123456', password: 'Clave-1' }, req as never)).resolves.toEqual({
      enabled: true,
    });
    await expect(ctrl.disable(user, { code: '654321' }, req as never)).resolves.toEqual({ enabled: false });
    expect(enrollment.confirm).toHaveBeenCalledWith(user.sub, '123456', 'Clave-1', {
      ip: '203.0.113.7',
      userAgent: 'x'.repeat(512),
    });
    expect(enrollment.disable).toHaveBeenCalledWith(user.sub, '654321', expect.objectContaining({ ip: '203.0.113.7' }));
  });

  it('sin usuario en la petición → 401', async () => {
    const { ctrl } = makeController();
    expect(() => ctrl.status(undefined)).toThrow(UnauthorizedException);
  });
});
