import { describe, it, expect } from 'vitest';
import { anonymousRateLimitKey, isGlobalRateLimitExempt } from './global-rate-limit';

function req(url: string, peer: string, headers: Record<string, string> = {}, method = 'GET') {
  return { method, url, headers, raw: { socket: { remoteAddress: peer } } };
}

describe('límite global de peticiones', () => {
  it('el healthcheck del propio contenedor (loopback) no cuenta', () => {
    expect(isGlobalRateLimitExempt(req('/v1/health/live', '127.0.0.1'))).toBe(true);
    expect(isGlobalRateLimitExempt(req('/v1/health', '::ffff:127.0.0.1'))).toBe(true);
  });

  it('la foto de perfil del personal (GET con su huella) tiene su propio tope, no el global', () => {
    const id = '0b0e5d3e-6a56-4a3e-9d2f-0d6a8c0c9a11';
    expect(isGlobalRateLimitExempt(req(`/v1/staff/${id}/photo/${'a'.repeat(64)}`, '203.0.113.5'))).toBe(true);
    expect(isGlobalRateLimitExempt(req(`/v1/staff/${id}/photo`, '203.0.113.5', {}, 'DELETE'))).toBe(false);
  });

  it('loopback ya no exime al resto de rutas (un proxy local lo dejaría todo sin límite)', () => {
    expect(isGlobalRateLimitExempt(req('/v1/auth/login', '127.0.0.1', {}, 'POST'))).toBe(false);
    expect(isGlobalRateLimitExempt(req('/v1/venues', '::1'))).toBe(false);
  });

  it('health desde fuera sí cuenta', () => {
    expect(isGlobalRateLimitExempt(req('/v1/health', '10.0.1.7', { 'x-forwarded-for': '81.0.0.7' }))).toBe(false);
  });

  it('el sondeo del saldo va con su propio límite', () => {
    expect(isGlobalRateLimitExempt(req('/w/tok123/state', '10.0.1.7'))).toBe(true);
    expect(isGlobalRateLimitExempt(req('/w/tok123/state?x=1', '10.0.1.7'))).toBe(true);
    expect(isGlobalRateLimitExempt(req('/w/tok123/state', '10.0.1.7', {}, 'POST'))).toBe(false);
  });

  it('las páginas GET de /pay van con su propio límite (el «Comprobando» se refresca solo); los POST no', () => {
    for (const url of ['/pay/tok123', '/pay/tok123?lang=en', '/pay/tok123/checkout?op=ORD1&lang=es', '/pay/tok123/receipt', '/pay/result?op=ORD1']) {
      expect(isGlobalRateLimitExempt(req(url, '10.0.1.7'))).toBe(true);
    }
    expect(isGlobalRateLimitExempt(req('/pay/tok123', '10.0.1.7', {}, 'POST'))).toBe(false);
    expect(isGlobalRateLimitExempt(req('/pay/tok123/passkey', '10.0.1.7', {}, 'POST'))).toBe(false);
    expect(isGlobalRateLimitExempt(req('/pay/tok123/merge/challenge', '10.0.1.7'))).toBe(false);
    expect(isGlobalRateLimitExempt(req('/v1/pay/tok123', '10.0.1.7'))).toBe(false);
  });

  it('el estado del pago de «Comprobando el pago» va con su propio límite (por IP y por cobro)', () => {
    for (const url of ['/pay/tok123/status', '/pay/result/status?op=ORD1', '/pay/tok123/status?lang=en']) {
      expect(isGlobalRateLimitExempt(req(url, '10.0.1.7'))).toBe(true);
    }
    expect(isGlobalRateLimitExempt(req('/pay/tok123/status', '10.0.1.7', {}, 'POST'))).toBe(false);
    expect(isGlobalRateLimitExempt(req('/pay/tok123/status/x', '10.0.1.7'))).toBe(false);
  });

  it('IPv6: rotar de dirección dentro del mismo /64 no da cupo nuevo', () => {
    const a = anonymousRateLimitKey(req('/v1/x', '2001:db8:abcd:12::1'));
    expect(a).toBe('ip:2001:db8:abcd:12::/64');
    expect(anonymousRateLimitKey(req('/v1/x', '2001:db8:abcd:12:9:8:7:6'))).toBe(a);
  });

  it('la clave es la IP de fiar, no la cabecera que mande el cliente', () => {
    const viaCloudflare = req('/v1/x', '10.0.1.7', { 'cf-connecting-ip': '81.0.0.7', 'x-forwarded-for': '162.158.1.1' });
    expect(anonymousRateLimitKey(viaCloudflare)).toBe('ip:81.0.0.7');
    const directo = req('/v1/x', '10.0.1.7', { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '5.5.5.5, 81.0.0.9' });
    expect(anonymousRateLimitKey(directo)).toBe('ip:81.0.0.9');
  });
});
