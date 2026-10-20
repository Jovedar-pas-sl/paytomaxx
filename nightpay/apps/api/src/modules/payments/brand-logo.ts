/**
 * Logo de OxioCard para las páginas del cliente (/pay, /s, /w), que son
 * oscuras: el wordmark claro (crema con el punto lima). Va como data: URI
 * porque la CSP del API solo deja img-src 'self' data: y así la página no
 * pide nada más al cargar (el cliente puede tener mala red).
 *
 * Origen: el logo-wordmark-claro.png de la marca (3377 bytes, 269×43).
 * Usar la imagen, no imitarla con una fuente.
 */
export const OXIOCARD_WORDMARK = {
  src: [
    'data:image/png;base64,',
    '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',
    'YII=',
  ].join(''),
  width: 269,
  height: 43,
} as const;
