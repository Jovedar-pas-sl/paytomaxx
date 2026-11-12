// El cliente de «Mi perfil» (/v1/me/... y la foto): lo montan las apps del
// personal y el panel con su authedFetch. Los errores llevan el texto del API
// (ya en español) o uno de aquí si no explica nada.

import { staffPhotoPath, type MyProfile, type ProfileApi } from '@nightpay/contracts';
import { readApiError } from './problem';

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

const FALLBACKS: Record<number, string> = {
  400: 'Revisa lo que has escrito.',
  403: 'No tienes permiso para hacer eso.',
  409: 'Eso no se ha podido guardar.',
  413: 'La foto pesa demasiado.',
  429: 'Demasiados intentos. Espera un momento.',
};
const fallback = (status: number): string => FALLBACKS[status] ?? 'No se ha podido guardar. Vuelve a intentarlo.';

export function createProfileApi(authedFetch: AuthedFetch): ProfileApi {
  async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await authedFetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await readApiError(res, fallback);
    return (await res.json()) as T;
  }
  return {
    get: () => send<MyProfile>('/v1/me/profile', 'GET'),
    setName: (displayName) => send<MyProfile>('/v1/me/profile', 'PATCH', { displayName }),
    setPhone: (phone) => send<MyProfile>('/v1/me/contact', 'PATCH', { phone }),
    setEmail: (email, currentPassword) => send<MyProfile>('/v1/me/email', 'PATCH', { email, currentPassword }),
    changePassword: (input) => send<{ otherSessionsClosed: number }>('/v1/me/password', 'POST', input),
    setPhoto: (base64) => send<MyProfile>('/v1/me/photo', 'PUT', { data: base64 }),
    removePhoto: () => send<MyProfile>('/v1/me/photo', 'DELETE'),
    async fetchPhoto(userId, hash) {
      const res = await authedFetch(staffPhotoPath(userId, hash));
      if (res.status === 404) return null;
      if (!res.ok) throw await readApiError(res, fallback);
      return res.blob();
    },
  };
}
