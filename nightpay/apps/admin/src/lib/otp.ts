// Código de 6 cifras de la app de verificación (2FA): lo tecleado o pegado se
// limpia aquí, y el formulario se envía solo cuando se acaba de completar.

export const OTP_LENGTH = 6;

/** Solo cifras y como mucho `length` ("123 456" → "123456"). */
export function sanitizeOtp(raw: string, length: number = OTP_LENGTH): string {
  return raw.replace(/\D/g, '').slice(0, length);
}

/**
 * Lo pegado → código. Si hay un grupo de 6 cifras (con un espacio o un guion en
 * medio, "123 456"), es ese aunque haya más números alrededor ("en 30 s:
 * 123456"); si no, las cifras en orden.
 */
export function extractOtp(text: string, length: number = OTP_LENGTH): string {
  const half = Math.floor(length / 2);
  const grouped = new RegExp(`(?<!\\d)(\\d{${half}})[\\s-]?(\\d{${length - half}})(?!\\d)`).exec(text);
  if (grouped) return `${grouped[1]}${grouped[2]}`;
  return sanitizeOtp(text, length);
}

/** Se acaba de completar (o se pegó otro completo encima): toca enviarlo, una sola vez. */
export function justCompleted(previous: string, next: string, length: number = OTP_LENGTH): boolean {
  return next.length === length && next !== previous;
}
