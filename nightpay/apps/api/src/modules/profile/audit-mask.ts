// Lo que va a audit_events (solo se añade, no se puede limpiar) no lleva datos
// personales completos: el correo y el teléfono van tapados. Se conserva quién
// (userId) y qué campo cambió.

/** m***@dominio.com: la primera letra y el dominio. Sin forma de correo: ***. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${Array.from(email)[0]}***${email.slice(at)}`;
}

/** Solo las 3 últimas cifras: ***456. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length === 0 ? '***' : `***${digits.slice(-3)}`;
}
