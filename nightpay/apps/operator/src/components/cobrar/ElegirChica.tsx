'use client';

import { useEffect, useState } from 'react';
import type { InvitableStaff } from '@nightpay/contracts';
import { EmptyState, FormError } from '@nightpay/ui';
import { fetchInvitables } from '@/lib/api-cobro';
import { formatEur } from '@/lib/money';
import { SkelRows } from '../loading-shapes';
import { puestoChip, type CobrarContext } from './cobrar-context';
import { Chip, ScreenHeader } from './ScreenHeader';
import styles from './cobrar.module.css';

/**
 * «Elegir de la lista» (si la cámara falla y el local no pide el QR de la
 * chica, Ajustes → Invitaciones): las chicas del local, una por botón. Al
 * elegirla se cobra: «Un momento…» mientras tanto y, si falla, por qué.
 */
export function ElegirChica({
  ctx,
  who,
  priceCents,
  onPick,
  onBack,
  busy,
  error: chargeError,
}: {
  ctx: CobrarContext;
  who: string;
  priceCents: number;
  onPick: (chica: InvitableStaff) => void;
  onBack: () => void;
  /** Creando el cobro de la invitación. */
  busy: boolean;
  /** Por qué no se pudo cobrar la invitación. */
  error: string | null;
}) {
  const [list, setList] = useState<InvitableStaff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInvitables()
      .then((l) => {
        if (!cancelled) setList(l);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chip = puestoChip(ctx);
  return (
    <div className={styles.screen}>
      <ScreenHeader
        title="¿A quién invita?"
        subtitle={`${who.split(' · ')[0]} · ${formatEur(priceCents, { compact: true })}`}
        onBack={onBack}
        chip={chip ? <Chip color={chip.color}>{chip.label}</Chip> : null}
      />
      <div className={styles.body}>
        {error ? (
          <FormError>
            {error}
          </FormError>
        ) : list === null ? (
          // Cuatro filas como las de la lista (56 de alto, solo el nombre).
          <SkelRows count={4} line="40%" height="3.5rem" />
        ) : list.length === 0 ? (
          <EmptyState icon="users" title="Aún no hay compañeras en este local" text="Las da de alta el dueño o el encargado en el panel." />
        ) : (
          <div className={styles.pickList}>
            {list.map((c) => (
              <button key={c.id} type="button" className={styles.pickItem} onClick={() => onPick(c)} disabled={busy}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        {busy ? (
          <p className={styles.muted} role="status">
            Un momento…
          </p>
        ) : null}
        {chargeError ? (
          <FormError>
            {chargeError}
          </FormError>
        ) : null}
      </div>
    </div>
  );
}
