/**
 * QR de la página del saldo del cliente → su código ("K7Q4M2").
 *
 * El QR lleva un enlace a esta app con ?saldo=K7Q4M2 (así vale también la
 * cámara normal del móvil) o, sin dominio configurado, el código a secas.
 * Cualquier otra cosa (p. ej. el enlace del propio saldo /w/…) no vale: ese
 * enlace es la credencial del cliente y aquí no se usa.
 */
const WALLET_CODE = /^[A-Z0-9]{6}$/;

export function walletCodeFromQr(text: string): string | null {
  const raw = text.trim();
  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      candidate = new URL(raw).searchParams.get('saldo') ?? '';
    } catch {
      return null;
    }
  }
  const code = candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return WALLET_CODE.test(code) ? code : null;
}
