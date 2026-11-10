'use client';

import { useEffect, useState } from 'react';
import type { WalletFicha } from '@nightpay/contracts';
import { fetchWalletFicha, markFicha } from '@/lib/api';
import { walletSheet } from '@/lib/ficha-sheets';
import { eurShort } from '@/lib/money-map-view';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { FichaSheet, SheetChip } from './FichaSheet';
import { FichaTimeline } from './FichaTimeline';

/**
 * Ficha del saldo (maqueta 9.1): lo que le queda y la cuenta que cuadra
 * (recargado − gastado − devuelto), su ficha NFC con «Bloquear» y, en una
 * línea del tiempo, cada recarga (cómo y quién) y cada gasto (referencia,
 * sección, chica y por dónde).
 */
export function WalletFichaModal({ walletId, onClose }: { walletId: string; onClose: () => void }) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const [ficha, setFicha] = useState<WalletFicha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [blocking, setBlocking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchWalletFicha(walletId)
      .then((f) => {
        if (!cancelled) setFicha(f);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [walletId, attempt]);

  const sheet = ficha ? walletSheet(ficha, sections, tz) : null;

  async function block(cardId: string, label: string): Promise<void> {
    if (!window.confirm(`¿Bloquear la ficha ${label}? Ya no podrá pagar con ella (el saldo sigue: se le puede dar otra).`)) return;
    setBlocking(true);
    setError(null);
    try {
      await markFicha(cardId, 'block');
      setAttempt((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBlocking(false);
    }
  }

  return (
    <FichaSheet
      title={sheet?.title ?? 'Saldo'}
      subtitle={sheet?.subtitle ?? 'Cargando…'}
      chip={<SheetChip hold>Saldo</SheetChip>}
      stripe={sheet?.stripe}
      onBack={onClose}
      backLabel="Cerrar la ficha del saldo"
    >
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
          {error}
        </Notice>
      ) : null}
      {!sheet ? (
        error ? null : <p className="np-ficha-empty">Cargando…</p>
      ) : (
        <>
          <div className="np-ficha-stats">
            <div className="np-ficha-stat" data-big="true">
              <span>Le quedan</span>
              <b>{eurShort(sheet.stats.left)}</b>
            </div>
            <div className="np-ficha-stat">
              <span>Recargado</span>
              <b>{eurShort(sheet.stats.topped)}</b>
            </div>
            <div className="np-ficha-stat">
              <span>Gastado</span>
              <b>{eurShort(sheet.stats.spent)}</b>
            </div>
            <div className="np-ficha-stat">
              <span>Devuelto</span>
              <b>{eurShort(sheet.stats.refunded)}</b>
            </div>
          </div>

          <div className="np-ficha-nfc">
            <span className="np-ficha-card" data-off={sheet.card && !sheet.card.active ? 'true' : undefined} aria-hidden="true" />
            <div className="np-mm-grow">
              <b>{sheet.card ? `Ficha ${sheet.card.label}` : 'Sin ficha NFC'}</b>
              <span>{sheet.card ? sheet.card.detail : sheet.noCardDetail}</span>
            </div>
            {sheet.card ? (
              <button
                type="button"
                className="np-ficha-mini"
                disabled={!sheet.card.active || blocking}
                onClick={() => void block(sheet.card!.id, sheet.card!.label)}
              >
                {sheet.card.active ? (blocking ? 'Bloqueando…' : 'Bloquear') : 'Bloqueada'}
              </button>
            ) : null}
          </div>

          {sheet.phone ? (
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              Teléfono: <b>{sheet.phone}</b> · solo para encontrar su saldo si pierde la ficha
            </p>
          ) : null}
          <FichaTimeline rows={sheet.rows} empty="Aún no tiene movimientos." label="Recargas, gastos y devoluciones" />
        </>
      )}
    </FichaSheet>
  );
}
