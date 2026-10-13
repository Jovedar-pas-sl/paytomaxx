/**
 * Nombre de la marca que ven el cliente y el personal: pantallas, concepto
 * del cobro en la pasarela, justificantes y correos. Se cambia sin tocar
 * código con BRAND_NAME.
 *
 * OJO: el nombre que sale en el EXTRACTO del banco del cliente no es este. Lo
 * fija BBVA (nombre comercial del contrato del TPV); PAY_STATEMENT_NAME solo
 * avisa al cliente de cómo le va a salir.
 */
export const BRAND_NAME = process.env.BRAND_NAME?.trim() || 'OxioPay';
