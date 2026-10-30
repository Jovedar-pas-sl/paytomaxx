/**
 * Marcas de pago de las páginas del cliente (/pay, /r): el botón de Google
 * Pay, las chapas de Visa y Mastercard y los iconos de trazo de los botones.
 * Todo en SVG dentro de la página: la CSP del API no deja cargar nada de
 * fuera y el cliente puede tener mala red.
 *
 * Apple Pay no está aquí a propósito: su botón lo pinta Safari
 * (-apple-pay-button, pay-choose-page.ts), nunca uno hecho a mano.
 * Google Pay: su «G» de colores (la del logo de Google) y «Pay» en gris, sobre
 * blanco, como su botón claro para fondos oscuros. Visa y Mastercard: sus
 * marcas de aceptación, en chapa blanca. Trazados de Simple Icons (CC0),
 * sacados de los SVG de cada marca.
 */

/** «Pago seguro» con las chapas (en /pay y en el enlace del local). */
export const PAY_MARKS_CSS = `.trust{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:.35rem .55rem;font-size:.8rem;color:var(--dim)}
.marks{display:inline-flex;gap:.3rem}
.marks svg{display:block;width:2rem;height:1.26rem}
`;

/** Candado del botón de pagar. */
export const LOCK_IC =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** Tarjeta de «Pagar con tarjeta». */
export const CARD_IC =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg>';

/** «G Pay» del botón de Google Pay (decorativo: el nombre va en el texto del botón). */
export const GPAY_MARK = `<svg class="gmark" viewBox="0 7 24 10.4" aria-hidden="true"><g transform="translate(0 7.2) scale(.1652)"><path fill="#ea4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285f4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#fbbc05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34a853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></g><path fill="#3c4043" d="M10.464 7.785v6.9h.886V11.89h1.465c.603 0 1.11-.196 1.522-.588a1.911 1.911 0 00.635-1.464 1.92 1.92 0 00-.635-1.456 2.125 2.125 0 00-1.522-.598zm2.427.85a1.156 1.156 0 01.823.365 1.176 1.176 0 010 1.686 1.171 1.171 0 01-.877.357H11.35V8.635h1.487a1.156 1.156 0 01.054 0zm4.124 1.175c-.842 0-1.477.308-1.907.925l.781.491c.288-.417.68-.626 1.175-.626a1.255 1.255 0 01.856.323 1.009 1.009 0 01.366.785v.202c-.34-.193-.774-.289-1.3-.289-.617 0-1.11.145-1.479.434-.37.288-.554.677-.554 1.165a1.476 1.476 0 00.525 1.156c.35.308.785.463 1.305.463.61 0 1.098-.27 1.465-.81h.038v.655h.848v-2.909c0-.61-.19-1.09-.568-1.44-.38-.35-.896-.525-1.551-.525zm2.263.154l1.946 4.422-1.098 2.38h.915L24 9.963h-.965l-1.368 3.391h-.02l-1.406-3.39zm-2.146 2.368c.494 0 .88.11 1.156.33 0 .372-.147.696-.44.973a1.413 1.413 0 01-.997.414 1.081 1.081 0 01-.69-.232.708.708 0 01-.293-.578c0-.257.12-.47.363-.647.24-.173.54-.26.9-.26Z"/></svg>`;

/** Visa y Mastercard en su chapa blanca (con qué tarjetas se puede pagar). */
export const CARD_MARKS = `<span class="marks" role="img" aria-label="Visa, Mastercard"><svg viewBox="0 0 38 24" aria-hidden="true"><rect width="38" height="24" rx="4" fill="#fff"/><path fill="#1a1f71" transform="translate(5 -2.05) scale(1.1667)" d="M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z"/></svg><svg viewBox="0 0 38 24" aria-hidden="true"><rect width="38" height="24" rx="4" fill="#fff"/><circle cx="15" cy="12" r="7" fill="#eb001b"/><circle cx="23" cy="12" r="7" fill="#f79e1b"/><path fill="#ff5f00" d="M19 6.255A7 7 0 0 1 19 17.745A7 7 0 0 1 19 6.255z"/></svg></span>`;
