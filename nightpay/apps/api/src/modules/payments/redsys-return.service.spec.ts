import { describe, expect, it, vi } from 'vitest';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { createCipheriv, createHmac } from 'node:crypto';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { RedsysReturnService } from './redsys-return.service';

const ORDER = '2610170002CD';
const KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

function signed(fields: Record<string, string> = {}) {
  const values = {
    Ds_Order: ORDER,
    Ds_Merchant_Order: ORDER,
    Ds_MerchantCode: '999008881',
    Ds_Response: '0000',
    Ds_TransactionType: '0',
    Ds_Amount: '3830',
    Ds_Currency: '978',
    ...fields,
  };
  return serializeAndSignJSONRequest(KEY, values as never);
}

function setup() {
  const config = { get: (key: string) => ({
    REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago',
    REDSYS_MERCHANT_CODE: '999008881',
    REDSYS_TERMINAL: '1',
    REDSYS_SECRET_KEY: KEY,
  } as Record<string, string>)[key] };
  const adapter = new RedsysAdapter(config as never, { circuitState: { set: vi.fn() }, gatewayDuration: { observe: vi.fn() } } as never);
  const receiveRedsys = vi.fn().mockResolvedValue({ received: true });
  return { service: new RedsysReturnService(adapter, { receiveRedsys } as never), receiveRedsys };
}

describe('vuelta firmada de Redsys', () => {
  it('no registra una recarga de espera, pero sí una vuelta sin firma', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const h = setup();
      await h.service.process(ORDER, { op: ORDER, lang: 'es' });
      expect(log).not.toHaveBeenCalled();
      await h.service.process(ORDER, { op: ORDER, status: 'ok' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('firma=no resultado=sin-firma'));
    } finally { log.mockRestore(); }
  });

  it('registra firma=no cuando la firma es incorrecta, sin guardar los parámetros', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const h = setup();
      await h.service.process(ORDER, { ...signed(), Ds_Signature: 'firma-alterada' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('firma=no resultado=firma-mala'));
      expect(log.mock.calls.flat().join(' ')).not.toContain('firma-alterada');
    } finally { log.mockRestore(); }
  });

  it('no reintenta cuando el aviso fue rechazado definitivamente', async () => {
    const h = setup();
    h.receiveRedsys.mockRejectedValueOnce(new UnauthorizedException());
    expect(await h.service.process(ORDER, signed())).toBe('rechazado');
  });

  it('reintenta la misma prueba después de un fallo pasajero al guardar', async () => {
    const h = setup();
    const fields = signed();
    h.receiveRedsys.mockRejectedValueOnce(new Error('fallo temporal'));
    expect(await h.service.process(ORDER, fields)).toBe('error');
    expect(await h.service.process(ORDER, fields)).toBe('enviado');
    expect(h.receiveRedsys.mock.calls[0]![0].body).toEqual(h.receiveRedsys.mock.calls[1]![0].body);
  });

  it('una aprobación firmada del pedido se entrega al mismo camino del aviso', async () => {
    const h = setup();
    const fields = signed();
    await expect(h.service.process(ORDER, fields)).resolves.toBe('enviado');
    expect(h.receiveRedsys).toHaveBeenCalledTimes(1);
    expect(h.receiveRedsys.mock.calls[0]![0]).toMatchObject({ body: fields, headers: {} });
  });

  it('sin firma, incompleta o alterada no procesa un pago', async () => {
    const h = setup();
    expect(await h.service.process(ORDER, { status: 'ok' })).toBe('sin-firma');
    expect(await h.service.process(ORDER, { Ds_Signature: 'a' })).toBe('sin-firma');
    expect(await h.service.process(ORDER, { ...signed(), Ds_Signature: 'firma-alterada' })).toBe('firma-mala');
    expect(h.receiveRedsys).not.toHaveBeenCalled();
  });

  it('una firma válida de otro pedido o una operación no aprobada no procesa este pago', async () => {
    const h = setup();
    expect(await h.service.process('OTROPEDIDO', signed())).toBe('pedido-distinto');
    expect(await h.service.process(ORDER, signed({ Ds_Response: '0190' }))).toBe('no-aprobado');
    expect(await h.service.process(ORDER, signed({ Ds_TransactionType: '3' }))).toBe('no-aprobado');
    expect(h.receiveRedsys).not.toHaveBeenCalled();
  });

  it('el importe firmado se conserva para la comprobación y la incidencia del procesador', async () => {
    const h = setup();
    const fields = signed({ Ds_Amount: '1' });
    expect(await h.service.process(ORDER, fields)).toBe('enviado');
    expect(h.receiveRedsys.mock.calls[0]![0].body).toEqual(fields);
  });

  it('repara los signos + que la dirección de vuelta convierte en espacios', async () => {
    const h = setup();
    let fields = signed();
    for (let i = 32; i < 4096 && !fields.Ds_MerchantParameters.includes('+'); i++) {
      fields = signed({ Ds_MerchantData: String.fromCharCode(i) });
    }
    expect(fields.Ds_MerchantParameters).toContain('+');
    const query = {
      ...fields,
      Ds_MerchantParameters: fields.Ds_MerchantParameters.replace(/\+/g, ' '),
      Ds_Signature: fields.Ds_Signature.replace(/\+/g, ' '),
    };
    expect(await h.service.process(ORDER, query)).toBe('enviado');
    expect(h.receiveRedsys.mock.calls[0]![0].body).toEqual(fields);
  });

  it('admite parámetros base64url firmados tal como los envía el banco', async () => {
    const h = setup();
    let fields = signed();
    for (let i = 32; i < 4096 && !/[+/]/.test(fields.Ds_MerchantParameters); i++) {
      fields = signed({ Ds_MerchantData: String.fromCharCode(i) });
    }
    expect(fields.Ds_MerchantParameters).toMatch(/[+/]/);
    const params = Buffer.from(fields.Ds_MerchantParameters, 'base64').toString('base64url');
    const order = Buffer.from(ORDER);
    const padded = Buffer.concat([order, Buffer.alloc((8 - order.length % 8) % 8)]);
    const cipher = createCipheriv('des-ede3-cbc', Buffer.from(KEY, 'base64'), Buffer.alloc(8));
    cipher.setAutoPadding(false);
    const orderKey = Buffer.concat([cipher.update(padded), cipher.final()]);
    const signature = createHmac('sha256', orderKey).update(params).digest('base64url');
    expect(await h.service.process(ORDER, { ...fields, Ds_MerchantParameters: params, Ds_Signature: signature })).toBe('enviado');
  });
  it('una vuelta repetida entrega la misma firma y el mismo pedido para deduplicar', async () => {
    const h = setup();
    const fields = signed();
    await Promise.all([h.service.process(ORDER, fields), h.service.process(ORDER, fields)]);
    expect(h.receiveRedsys).toHaveBeenCalledTimes(2);
    expect(h.receiveRedsys.mock.calls[0]![0].body).toEqual(h.receiveRedsys.mock.calls[1]![0].body);
  });
});