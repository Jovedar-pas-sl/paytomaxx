'use client';

import { useEffect, useState } from 'react';
import { Button } from '@nightpay/ui';
import {
  closeReceptionIncident,
  fetchReceptionIncidents,
  incidentWhen,
  noteReady,
  type ReceptionIncident,
} from '@/lib/api-incidencias';
import { formatEur } from '@/lib/money';
import r from './reception.module.css';

/**
 * Recepción → Incidencias: «El cliente dice que no ha sido él». El cliente
 * pulsó «No he sido yo» en el aviso de un cobro: su ficha y su PIN ya no
 * pagan. Recepción lo revisa con él y lo cierra escribiendo qué se hizo
 * (como en el panel). Quitar el bloqueo del PIN sigue siendo del encargado.
 */
export function ReceptionIncidents({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<ReceptionIncident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function load(): Promise<void> {
    try {
      setRows(await fetchReceptionIncidents());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function close(row: ReceptionIncident): Promise<void> {
    if (!noteReady(note) || saving) return;
    setSaving(true);
    try {
      await closeReceptionIncident(row.refId, note, row.kind);
      setOpen(null);
      setNote('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={r.card}>
      <p className={r.kicker}>Incidencias</p>
      <p className={r.text}>
        Clientes que dicen que un cobro de su saldo no lo hicieron ellos (su ficha y su PIN ya no pagan), cobros cancelados que el
        banco cobró después y compañeras que dicen que un servicio cobrado a su nombre no es suyo («No es mío»).
      </p>
      {rows === null && !error ? <p className={r.text}>Cargando…</p> : null}
      {rows?.length === 0 ? <p className={r.lead}>No hay ninguna.</p> : null}
      {(rows ?? []).map((row) => (
        <section key={row.refId} className={r.incident} aria-labelledby={`inc-${row.refId}`}>
          <p className={r.kicker}>{incidentWhen(row.occurredAt)}</p>
          <p id={`inc-${row.refId}`} className={r.incidentTitle}>
            {row.title}
            {row.amountCents !== null ? (
              <>
                {' · '}
                <span className="np-num">{formatEur(row.amountCents)}</span>
              </>
            ) : null}
          </p>
          <p className={r.text}>{row.detail}</p>
          {row.ackable === false ? (
            <p className={r.note}>
              {row.kind === 'service_disputed'
                ? 'Lo cierra el dueño en el panel. Habla con quien lo cobró.'
                : 'Lo cierra el encargado o el dueño: devuelto en el banco o dado por bueno.'}
            </p>
          ) : open === row.refId ? (
            <div className={r.form}>
              <label className={r.kicker} htmlFor={`nota-${row.refId}`}>
                {row.kind === 'approval_unbooked'
                  ? 'Qué has hecho (por ejemplo, «devuelto en el banco» o «dado por bueno»)'
                  : 'Qué has hecho (por ejemplo, «devuelto» o «era suyo»)'}
              </label>
              <textarea
                id={`nota-${row.refId}`}
                className={r.noteField}
                maxLength={300}
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {row.kind === 'wallet_charge_disputed' ? (
                <p className={r.note}>Para quitar el bloqueo del PIN, avisa al encargado (panel → Saldos).</p>
              ) : null}
              <Button onClick={() => void close(row)} disabled={!noteReady(note)} loading={saving} loadingLabel="Cerrando">
                Cerrar aviso
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(null);
                  setNote('');
                }}
              >
                Ahora no
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(row.refId);
                setNote('');
              }}
            >
              Cerrar con una nota
            </Button>
          )}
        </section>
      ))}
      {error ? (
        <p role="alert" className={r.error}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" onClick={() => void load()}>
        Actualizar
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Volver
      </Button>
    </div>
  );
}
