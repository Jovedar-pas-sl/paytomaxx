/**
 * Textos del enlace de alta. El enlace es de un solo uso: al guardar deja de
 * valer (si no, quien lo viera podría cambiar a dónde va su dinero). Si se
 * perdió la respuesta y reintenta, o lo vuelve a abrir, el API dice que ya se
 * guardó y se enseña la pantalla final, no «Link inválido».
 */
export const ONBOARDING_LINK_NOTE =
  'Al guardar, este enlace deja de valer. Si luego quieres cambiar algo, pide al admin un enlace nuevo.';

export type SavedKind = 'now' | 'before';

export function savedScreen(kind: SavedKind): { title: string; text: string } {
  return kind === 'now'
    ? { title: '✓ Guardado', text: 'Hemos recibido tus datos. Si necesitas cambiarlos, pídele al admin un enlace nuevo.' }
    : {
        title: '✓ Ya estaba guardado',
        text: 'Tus datos ya se guardaron con este enlace. Si quieres cambiar algo, pídele al admin un enlace nuevo.',
      };
}
