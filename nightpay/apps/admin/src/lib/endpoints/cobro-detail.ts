// «Ver detalle» de un cobro: todo lo que el encargado o el dueño pueden ver de
// él (lo delicado, solo con la verificación del momento: si no, sensitive null).

import type { CobroDetail, CobroKind } from '@nightpay/contracts';
import { authedFetch, totpAwareError } from '../http';

export async function fetchCobroDetail(kind: CobroKind, id: string): Promise<CobroDetail> {
  const res = await authedFetch(`/v1/admin/cobros/${kind}/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw await totpAwareError(res);
  return res.json();
}
