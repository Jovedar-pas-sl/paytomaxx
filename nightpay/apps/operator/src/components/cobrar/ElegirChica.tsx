'use client';

import { useEffect, useState } from 'react';
import type { InvitableStaff } from '@nightpay/contracts';
import { fetchInvitables } from '@/lib/api-cobro';
import { formatEur } from '@/lib/money';
import { colorOf, puestoChip, type CobrarContext } from './cobrar-context';
import { Chip, ScreenHeader, Stripe } from './ScreenHeader';
import styles from './cobrar.module.css';

/**
 * «Elegir de la lista» (si la cámara falla y el local no pide el QR de la
 * chica, Ajustes → Invitaciones): las chicas del local, una por botón.
 */
export function ElegirChica({
  ctx,
  who,
  priceCents,
  onPick,
  onBack,
}: {
  ctx: CobrarContext;
  who: string;
  priceCents: number;
  onPick: (chica: InvitableStaff) => void;
  onBack: () => void;
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
        chip={chip ? <Chip colors={[chip.color]}>{chip.label}</Chip> : null}
      />
      <Stripe parts={[{ color: colorOf('VENUE_BAR'), weight: 1 }]} />
      <div className={styles.body}>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : list === null ? (
          <p className={styles.muted}>Cargando…</p>
        ) : list.length === 0 ? (
          <p className={styles.empty}>No hay chicas dadas de alta en el local.</p>
        ) : (
          <div className={styles.pickList}>
            {list.map((c) => (
              <button key={c.id} type="button" className={styles.pickItem} onClick={() => onPick(c)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
