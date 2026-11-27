import { describe, expect, it } from 'vitest';
import type { PartnerView } from '@nightpay/contracts';
import {
  COLLECTION_TEXT,
  EMPTY_PARTNER_FORM,
  FREEZE_CHOICES,
  partnerChanges,
  partnerFormOf,
  partnerMissing,
  partnerPayload,
  updateNeedsTotp,
  type PartnerForm,
} from './partner-forms';

// Consola → «Socios»: el registro de cada plataforma (techo de permisos, IP
// declaradas, KYB y contrato de datos). Lo tecleado → lo que se manda a
// /v1/superadmin/partners, con el error en llano; el API lo vuelve a mirar.

function filled(over: Partial<PartnerForm> = {}): PartnerForm {
  return {
    ...EMPTY_PARTNER_FORM,
    name: 'Cajeros Demo',
    legalName: 'Cajeros Demo, S.L.',
    taxId: 'b-12345678',
    contactEmail: 'ops@cajeros.example',
    allowedScopes: ['wallet:balance', 'wallet:load'],
    egressIps: '203.0.113.7\n 203.0.113.8 \n',
    kybCheckedAt: '2026-11-20',
    dataRole: 'PROCESSOR_OF_VENUE',
    dpaSignedAt: '2026-11-21',
    dpaVersion: 'v1',
    dataCountry: 'es',
    ...over,
  };
}

function view(over: Partial<PartnerView> = {}): PartnerView {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Cajeros Demo',
    legalName: 'Cajeros Demo, S.L.',
    taxId: 'B12345678',
    contactEmail: 'ops@cajeros.example',
    status: 'ACTIVE',
    allowedScopes: ['wallet:balance', 'wallet:load'],
    collectionModel: 'VENUE_COLLECTS',
    channel: 'in_venue',
    egressIps: ['203.0.113.7', '203.0.113.8'],
    egressRangeReason: null,
    kybCheckedAt: '2026-11-20T12:00:00.000Z',
    kybNotes: null,
    dataRole: 'PROCESSOR_OF_VENUE',
    dpaSignedAt: '2026-11-21T12:00:00.000Z',
    dpaVersion: 'v1',
    dataCountry: 'ES',
    transferMechanism: null,
    notes: null,
    ready: true,
    createdAt: '2026-11-20T12:00:00.000Z',
    updatedAt: '2026-11-20T12:00:00.000Z',
    ...over,
  };
}

describe('alta de un socio', () => {
  it('lo que se manda: CIF limpio, una IP por línea, fechas a mediodía UTC y el país en mayúsculas', () => {
    expect(partnerPayload(filled())).toEqual({
      ok: true,
      value: {
        name: 'Cajeros Demo',
        legalName: 'Cajeros Demo, S.L.',
        taxId: 'B12345678',
        contactEmail: 'ops@cajeros.example',
        allowedScopes: ['wallet:balance', 'wallet:load'],
        channel: 'in_venue',
        egressIps: ['203.0.113.7', '203.0.113.8'],
        egressRangeReason: null,
        kybCheckedAt: '2026-11-20T12:00:00.000Z',
        kybNotes: null,
        dataRole: 'PROCESSOR_OF_VENUE',
        dpaSignedAt: '2026-11-21T12:00:00.000Z',
        dpaVersion: 'v1',
        dataCountry: 'ES',
        transferMechanism: null,
        notes: null,
      },
    });
  });

  it('un rango de más de una dirección necesita el motivo', () => {
    const msg = 'Un rango de más de una dirección necesita el motivo.';
    expect(partnerPayload(filled({ egressIps: '198.51.100.0/24' }))).toEqual({ ok: false, error: msg });
    expect(partnerPayload(filled({ egressIps: '2001:db8:1:2::/64' }))).toEqual({ ok: false, error: msg });
    expect(partnerPayload(filled({ egressIps: '198.51.100.0/24', egressRangeReason: 'Salen por un NAT de su nube' })).ok).toBe(true);
    // Una dirección escrita como /32 o /128 es una sola.
    expect(partnerPayload(filled({ egressIps: '203.0.113.9/32\n2001:db8::1/128' })).ok).toBe(true);
  });

  it('fuera del EEE hace falta el mecanismo de transferencia', () => {
    expect(partnerPayload(filled({ dataCountry: 'US' }))).toEqual({
      ok: false,
      error: 'Fuera del EEE hace falta el mecanismo de transferencia.',
    });
    expect(partnerPayload(filled({ dataCountry: 'US', transferMechanism: 'Cláusulas contractuales tipo (2021/914)' })).ok).toBe(true);
    expect(partnerPayload(filled({ dataCountry: 'NO' })).ok).toBe(true);
  });

  it('lo obligatorio, en llano', () => {
    expect(partnerPayload(filled({ name: 'X' }))).toEqual({ ok: false, error: 'El nombre, de 2 a 30 caracteres.' });
    expect(partnerPayload(filled({ name: 'Visita www.cajeros.es' }))).toEqual({
      ok: false,
      error: 'El nombre, sin enlaces, dominios, < ni >.',
    });
    expect(partnerPayload(filled({ taxId: '12' }))).toEqual({ ok: false, error: 'NIF/CIF: de 5 a 20 letras o cifras.' });
    expect(partnerPayload(filled({ contactEmail: 'ops' }))).toEqual({ ok: false, error: 'El correo de contacto no es válido.' });
    expect(partnerPayload(filled({ allowedScopes: [] }))).toEqual({ ok: false, error: 'Marca al menos un permiso.' });
    expect(partnerPayload(filled({ dataCountry: 'España' }))).toEqual({ ok: false, error: 'País: el código de dos letras (ES, PT…).' });
    expect(partnerPayload(filled({ egressIps: Array.from({ length: 21 }, (_, i) => `203.0.113.${i}`).join('\n') }))).toEqual({
      ok: false,
      error: 'Como mucho 20 IP.',
    });
  });

  it('sin KYB ni contrato también se da de alta (aún no podrá recibir claves)', () => {
    const r = partnerPayload(filled({ kybCheckedAt: '', dataRole: '', dpaSignedAt: '', dpaVersion: '', dataCountry: '' }));
    expect(r).toMatchObject({ ok: true, value: { kybCheckedAt: null, dataRole: null, dpaSignedAt: null, dpaVersion: null, dataCountry: null } });
  });
});

describe('editar un socio', () => {
  it('solo lo que cambia; los permisos, las IP, el KYB y el contrato piden la 2FA', () => {
    const before = view();
    const same = partnerPayload(partnerFormOf(before));
    expect(same.ok && partnerChanges(before, same.value)).toEqual({});

    const renamed = partnerPayload(partnerFormOf(before, { notes: 'Contacto nuevo' }));
    expect(renamed.ok && partnerChanges(before, renamed.value)).toEqual({ notes: 'Contacto nuevo' });
    expect(updateNeedsTotp({ notes: 'x', name: 'Otro' })).toBe(false);

    const ips = partnerPayload(partnerFormOf(before, { egressIps: '203.0.113.7' }));
    const changes = ips.ok ? partnerChanges(before, ips.value) : {};
    expect(changes).toEqual({ egressIps: ['203.0.113.7'] });
    expect(updateNeedsTotp(changes)).toBe(true);
    expect(updateNeedsTotp({ allowedScopes: ['wallet:balance'] })).toBe(true);
    expect(updateNeedsTotp({ kybCheckedAt: null })).toBe(true);
    expect(updateNeedsTotp({ dpaVersion: 'v2' })).toBe(true);
  });
});

describe('lo que le falta para recibir claves', () => {
  it('KYB, contrato de datos y, fuera del EEE, el mecanismo', () => {
    expect(partnerMissing(view())).toEqual([]);
    expect(partnerMissing(view({ kybCheckedAt: null, dpaSignedAt: null }))).toEqual(['el KYB', 'la firma del contrato de datos']);
    expect(partnerMissing(view({ dataCountry: 'US' }))).toEqual(['el mecanismo de transferencia']);
    expect(partnerMissing(view({ status: 'SUSPENDED' }))).toEqual(['quitarle la suspensión']);
  });
});

describe('la congelación de la API y quién cobra', () => {
  it('tres posiciones, en llano', () => {
    expect(FREEZE_CHOICES.map((f) => [f.value, f.label])).toEqual([
      ['none', 'Funciona'],
      ['money', 'Congelado lo que mueve dinero'],
      ['all', 'Todo congelado'],
    ]);
  });

  it('«Quién cobra: el local», fijo', () => {
    expect(COLLECTION_TEXT).toBe('Quién cobra: el local');
  });
});
