import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  formatBalance,
  genericClass,
  genericObject,
  linkHash,
  passObjectId,
  passState,
  revokedObjectPatch,
  type PassWallet,
} from './google-wallet-pass';

const TOKEN = 'Qm9vLXRva2VuLTE0NC1iaXRz';
const SETTINGS = { issuerId: '3388000000012345678', classSuffix: 'oxiopay_saldo' };
const CLASS_ID = `${SETTINGS.issuerId}.${SETTINGS.classSuffix}`;
const URL_W = `https://api.paytomaxx.com/w/${TOKEN}`;

function wallet(o: Partial<PassWallet> = {}): PassWallet {
  return { balanceCents: 20_000, status: 'ACTIVE', merged: false, venueName: 'Luna Valencia', ...o };
}

function object(o: Partial<PassWallet> = {}) {
  const objectId = passObjectId(SETTINGS, linkHash(TOKEN));
  return genericObject({ objectId, classId: CLASS_ID, brand: 'OxioPay', walletUrl: URL_W, wallet: wallet(o) });
}

describe('saldo en euros', () => {
  it('como en la página: 200,00 € en español y €200.00 en inglés', () => {
    expect(formatBalance(20_000, 'es')).toMatch(/^200,00\s€$/);
    expect(formatBalance(20_000, 'en')).toBe('€200.00');
    expect(formatBalance(0, 'es')).toMatch(/^0,00\s€$/);
    expect(formatBalance(5, 'es')).toMatch(/^0,05\s€$/);
    expect(formatBalance(1_234_567, 'es')).toMatch(/^12\.345,67\s€$/);
    expect(formatBalance(1_234_567, 'en')).toBe('€12,345.67');
  });
});

describe('estado del pase', () => {
  it('activo o gastado (puede volver a cargarse) → ACTIVE', () => {
    expect(passState('ACTIVE', false)).toBe('ACTIVE');
    expect(passState('DEPLETED', false)).toBe('ACTIVE');
  });

  it('caducado, devuelto o sumado a otro saldo → INACTIVE (va a "Caducados")', () => {
    expect(passState('EXPIRED', false)).toBe('INACTIVE');
    expect(passState('REFUNDED', false)).toBe('INACTIVE');
    expect(passState('DEPLETED', true)).toBe('INACTIVE');
  });
});

describe('id del pase: sale de un hash, nunca del enlace', () => {
  it('<emisor>.<clase>-<40 hex del sha256 del enlace>', () => {
    const hash = linkHash(TOKEN);
    expect(hash).toBe(createHash('sha256').update(TOKEN).digest('hex'));
    const id = passObjectId(SETTINGS, hash);
    expect(id).toBe(`${CLASS_ID}-${hash.slice(0, 40)}`);
    expect(id).not.toContain(TOKEN);
    // Solo lo que admite Google en un id: letras, números, ".", "_" y "-".
    expect(id).toMatch(/^\d+\.[A-Za-z0-9._-]+$/);
  });

  it('otro enlace → otro pase', () => {
    expect(passObjectId(SETTINGS, linkHash('otro'))).not.toBe(passObjectId(SETTINGS, linkHash(TOKEN)));
  });
});

describe('clase y objeto que se mandan a Google', () => {
  it('clase: una sola cuenta de Google y hay que desbloquear el móvil para verlo', () => {
    expect(genericClass(CLASS_ID)).toEqual({
      id: CLASS_ID,
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
      viewUnlockRequirement: 'UNLOCK_REQUIRED_TO_VIEW',
    });
  });

  it('marca arriba, local debajo, el saldo grande y el QR que abre la página del saldo', () => {
    const o = object();
    expect(o.classId).toBe(CLASS_ID);
    expect(o.state).toBe('ACTIVE');
    expect(o.cardTitle.defaultValue).toEqual({ language: 'es', value: 'OxioPay' });
    expect(o.subheader.defaultValue.value).toBe('Luna Valencia');
    expect(o.header.defaultValue.value).toMatch(/^200,00\s€$/);
    expect(o.header.translatedValues).toEqual([{ language: 'en', value: '€200.00' }]);
    expect(o.barcode).toEqual({ type: 'QR_CODE', value: URL_W, alternateText: 'OxioPay' });
    expect(o.linksModuleData.uris[0]).toMatchObject({ uri: URL_W, description: 'Ver mi saldo' });
    expect(o.textModulesData.map((m) => m.id)).toEqual(['como']);
  });

  it('sin nombre del local → "Saldo"', () => {
    expect(object({ venueName: null }).subheader.defaultValue.value).toBe('Saldo');
  });

  it('devuelto → INACTIVE y dice que está cerrado; sumado → dice que se sumó', () => {
    const refunded = object({ status: 'REFUNDED', balanceCents: 0 });
    expect(refunded.state).toBe('INACTIVE');
    expect(refunded.header.defaultValue.value).toMatch(/^0,00\s€$/);
    expect(refunded.textModulesData[0]).toMatchObject({ id: 'estado', body: 'Este saldo ya está cerrado.' });
    const merged = object({ status: 'DEPLETED', merged: true, balanceCents: 0 });
    expect(merged.state).toBe('INACTIVE');
    expect(merged.textModulesData[0].body).toBe('Esta recarga se sumó a tu otro saldo.');
  });

  it('en el pase no van PIN, llave (Face ID) ni código del saldo: solo el enlace del cliente', () => {
    const json = JSON.stringify(object());
    expect(json).not.toMatch(/pin"|passkey|credential|shortCode|K7Q/i);
    // El único enlace es el de la página del saldo (QR y botón).
    const urls = json.match(/https?:\/\/[^"]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([URL_W]));
  });

  it('pase de un enlace viejo: se apaga y dice por qué', () => {
    const patch = revokedObjectPatch();
    expect(patch.state).toBe('INACTIVE');
    expect(patch.header.defaultValue.value).toBe('Enlace antiguo');
    expect(patch.textModulesData[0].id).toBe('estado');
    expect(JSON.stringify(patch)).not.toMatch(/https?:/);
  });
});
