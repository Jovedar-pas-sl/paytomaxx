// «Mi perfil» del panel (foto, nombre, contacto y contraseña de quien tiene la
// sesión) y quitar la foto de alguien del local (dueño y encargado).

import { createProfileApi, readApiError } from '@nightpay/api-client';
import { authedFetch } from '../http';

export const profileApi = createProfileApi((path, init) => authedFetch(path, init));

/** El dueño o el encargado quitan la foto de una persona de su local. Devuelve si había una. */
export async function removeStaffPhoto(userId: string): Promise<boolean> {
  const res = await authedFetch(`/v1/staff/${encodeURIComponent(userId)}/photo`, { method: 'DELETE' });
  if (!res.ok) throw await readApiError(res, () => 'No se ha podido quitar la foto.');
  return ((await res.json()) as { removed: boolean }).removed;
}
