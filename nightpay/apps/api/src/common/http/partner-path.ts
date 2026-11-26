/**
 * ¿Es de la API de socios (/v1/partner y lo de debajo)? Ahí, y solo ahí,
 * cambian los errores (problem+json del contrato), el id de la petición
 * (X-Request-Id), el tope del cuerpo y el límite global (modules/partner).
 */
const PARTNER_PATH = /^\/v1\/partner(?:[/?#]|$)/;

export function isPartnerPath(url: string | undefined | null): boolean {
  return typeof url === 'string' && PARTNER_PATH.test(url);
}
