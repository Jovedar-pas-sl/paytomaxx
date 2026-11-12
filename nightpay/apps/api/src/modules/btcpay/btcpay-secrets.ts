import { deriveKey, openText, sealText } from '../auth/aes-gcm';

/**
 * La clave de API de BTCPay y el secreto del aviso de cada local se guardan
 * cifrados (AES-256-GCM, clave derivada de ENCRYPTION_KEK, que no está en la
 * base): con una copia de la base no se pueden usar. El local y el tipo van
 * en los datos autenticados: un valor copiado a otro local, o la clave
 * puesta como secreto, no se abre.
 */
const KEY_PURPOSE = 'nightpay:btcpay-store:v1';
const MIN_KEK_LENGTH = 32;

export type BtcpaySecretKind = 'apikey' | 'webhook';

function keyOf(kek: string | undefined): Buffer {
  if (!kek || kek.length < MIN_KEK_LENGTH) throw new Error('ENCRYPTION_KEK no configurada: no se puede cifrar ni leer la clave de BTCPay');
  return deriveKey(kek, KEY_PURPOSE);
}

const aad = (tenantId: string, kind: BtcpaySecretKind): string => `btcpay:${kind}:${tenantId}`;

export function sealBtcpaySecret(kek: string | undefined, tenantId: string, kind: BtcpaySecretKind, plaintext: string): string {
  return sealText(keyOf(kek), plaintext, aad(tenantId, kind));
}

export function openBtcpaySecret(kek: string | undefined, tenantId: string, kind: BtcpaySecretKind, sealed: string): string {
  return openText(keyOf(kek), sealed, aad(tenantId, kind));
}
