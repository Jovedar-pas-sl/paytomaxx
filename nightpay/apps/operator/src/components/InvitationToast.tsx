'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@nightpay/ui';
import type { MyNight } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { playOutcomeSound } from '@/lib/alert-sound';
import { checkServed, invitationArrived, type ServedSeen } from '@/lib/invitation-toast';

/**
 * «Te han invitado · +10 €» (maqueta 2.5): la compañera lo ve en su app al
 * momento de cobrarse la invitación (con el sondeo de su noche). Y «Servicio
 * cobrado · +54 €» cuando otra persona le cobra un servicio a su nombre,
 * también si tenía la app cerrada (lo visto se guarda en el móvil). Los dos
 * salen por el aviso flotante común. Suena y vibra como un PAGADO.
 */
export function InvitationToast({ night, userId }: { night: MyNight | null; userId: string }) {
  const last = useRef<MyNight['invitations'] | null>(null);
  const lastServed = useRef<ServedSeen | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!night) return;
    const invited = invitationArrived(last.current, night.invitations);
    last.current = night.invitations ?? last.current;
    const { cents: served, seen } = checkServed(userId, lastServed.current, night);
    lastServed.current = seen;
    const next = served !== null ? { what: 'Servicio cobrado', cents: served } : invited !== null ? { what: 'Te han invitado', cents: invited } : null;
    if (!next) return;
    const { what, cents } = next;
    toast.show(`${what} · +${formatEur(cents, { compact: true })}`, { tone: 'success' });
    playOutcomeSound('paid');
  }, [night, userId, toast]);

  // Al salir de la sesión, su aviso no se queda en la pantalla de entrar (el aviso flotante es de toda la app).
  useEffect(() => () => toast.dismiss(), [toast]);

  return null;
}
