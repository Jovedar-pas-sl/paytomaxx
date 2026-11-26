import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PARTNER_ROUTES, type PartnerRouteDef } from '@nightpay/contracts';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { PartnerKeyGuard } from '../auth/partner-key.guard';
import { PARTNER_ROUTE, PartnerRoute } from './partner-route.decorator';
import { PartnerResponseInterceptor } from './partner-response.interceptor';

const POST_ROUTE: PartnerRouteDef = { ...PARTNER_ROUTES.getConnection, method: 'POST', path: '/prueba', operationId: 'prueba' };

class Prueba {
  @PartnerRoute(PARTNER_ROUTES.getConnection)
  me(): void {}

  @PartnerRoute(POST_ROUTE)
  post(): void {}
}

describe('@PartnerRoute(def)', () => {
  it('pone la definición de la tabla, @Public, el guard de la clave, el interceptor y el método con su ruta', () => {
    const h = Prueba.prototype.me;
    expect(Reflect.getMetadata(PARTNER_ROUTE, h)).toBe(PARTNER_ROUTES.getConnection);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, h)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, h)).toEqual([PartnerKeyGuard]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, h)).toEqual([PartnerResponseInterceptor]);
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, h)).toBe('/me');
  });

  it('POST con su ruta', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, Prueba.prototype.post)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, Prueba.prototype.post)).toBe('/prueba');
    expect(Reflect.getMetadata(PARTNER_ROUTE, Prueba.prototype.post)).toBe(POST_ROUTE);
  });
});
