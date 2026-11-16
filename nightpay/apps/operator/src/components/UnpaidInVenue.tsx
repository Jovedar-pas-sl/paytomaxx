'use client';

import { useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import { cancelPayment } from '@/lib/api';
import { fetchUnpaidCobros, unpaidCancelable, unpaidLine, unpaidState, unpaidToShow, type UnpaidCobro } from '@/lib/api-sin-pagar';
import { timeLabel } from '@/lib/earnings-view';
import { usePolling } from '@/lib/use-polling';
import { CancelCobroConfirm } from './CancelCobroConfirm';
import styles from './my-cobros.module.css';

/**
 * «Cobros» → «Sin pagar en el local»: los cobros sin pagar de todo el local,
 * también los de otra persona. Cualquiera del personal cancela cualquiera
 * (decisión del dueño), siempre confirmando, menos la recarga cobrada en el
 * datáfono sin comprobar: sale sin botón (la resuelven en el panel). Sin
 * ninguno, no sale nada.
 */
export function UnpaidInVenue({ ownListCancels, onCanceled }: { ownListCancels: boolean; onCanceled: () => void }) {
  const [items, setItems] = useState<UnpaidCobro[] | null>(null);
  const [target, setTarget] = useState<UnpaidCobro | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = usePolling(
    async (signal) => {
      setItems(await fetchUnpaidCobros(signal));
      return undefined;
    },
    { intervalMs: 10_000, timeoutMs: 30_000 },
  );

  async function confirm(u: UnpaidCobro): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await cancelPayment(u.id);
      setTarget(null);
      refresh();
      onCanceled();
    } catch (err) {
      setTarget(null);
      setError(`No se ha podido cancelar: ${(err as Error).message}`);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const shown = items ? unpaidToShow(items, ownListCancels) : [];
  if (shown.length === 0 && !error) return null;
  return (
    <Card style={{ padding: '0.875rem', display: 'grid', gap: '0.625rem' }} aria-labelledby="sin-pagar-local">
      <h3 id="sin-pagar-local" className={styles.kicker} style={{ margin: 0 }}>
        Sin pagar en el local
      </h3>
      {shown.map((u) => (
        <div key={u.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <div style={{ display: 'grid', gap: '0.125rem', minWidth: 0 }}>
            <b className="np-num" style={{ fontSize: 'var(--np-fs-16)', fontWeight: 600 }}>
              {unpaidLine(u)}
            </b>
            <span style={{ fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>
              {timeLabel(new Date(u.createdAt))} · {unpaidState(u)}
            </span>
          </div>
          {/* Cobrado en el datáfono sin comprobar: sin botón (lo dice la línea de arriba). */}
          {unpaidCancelable(u) ? (
            <Button variant="ghost" size="md" onClick={() => setTarget(u)} aria-label={`Cancelar el cobro ${unpaidLine(u)}`}>
              Cancelar
            </Button>
          ) : null}
        </div>
      ))}
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-danger-text)' }}>
          {error}
        </p>
      ) : null}
      <CancelCobroConfirm
        open={target !== null}
        atBank={target?.atBank ?? false}
        busy={busy}
        detail={target ? unpaidLine(target) : null}
        onConfirm={() => target && void confirm(target)}
        onClose={() => setTarget(null)}
      />
    </Card>
  );
}
