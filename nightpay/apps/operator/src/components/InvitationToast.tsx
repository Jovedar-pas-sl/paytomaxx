'use client';

import { useEffect, useRef } from 'react';
import { useToast } from '@nightpay/ui';
import type { MyNight } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { playOutcomeSound } from '@/lib/alert-sound';
import { invitationArrived } from '@/lib/invitation-toast';

/**
 * «Te han invitado · +10 €» (maqueta 2.5): la chica lo ve en su app al
 * momento de cobrarse la invitación (con el sondeo de su noche), en el aviso
 * flotante común. Suena y vibra como un PAGADO.
 */
export function InvitationToast({ night }: { night: MyNight | null }) {
  const last = useRef<MyNight['invitations'] | null>(null);
  const toast = useToast();

  useEffect(() => {
    const now = night?.invitations ?? null;
    const cents = invitationArrived(last.current, now);
    last.current = now ?? last.current;
    if (cents === null) return;
    toast.show(`Te han invitado · +${formatEur(cents, { compact: true })}`, { tone: 'success' });
    playOutcomeSound('paid');
  }, [night, toast]);

  // Al salir de la sesión, su aviso no se queda en la pantalla de entrar (el aviso flotante es de toda la app).
  useEffect(() => () => toast.dismiss(), [toast]);

  return null;
}
