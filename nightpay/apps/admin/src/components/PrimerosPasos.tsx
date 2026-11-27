'use client';

import { useEffect, useId, useState } from 'react';
import { Button, Icon, useToast } from '@nightpay/ui';
import { fetchCarta, fetchNights, fetchOperators, fetchTotpStatus } from '@/lib/api';
import { primerosPasos, primerosPasosFormasKey, primerosPasosKey, type PrimerosPasosDatos } from '@/lib/primeros-pasos';
import type { TabKey } from '@/lib/roles';

const HIDDEN = 'oculto';

function readMark(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeMark(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento: vuelve a salir la próxima vez; nada más.
  }
}

/**
 * Primeros pasos (entrega 10 A, idea 23): la tarjeta del dueño sobre
 * «Resumen» para dejar listo un local nuevo. Solo pregunta y navega; no sale
 * hasta saber los cinco datos, ni si alguno falla, ni con 3 noches. «Ocultar»
 * o 5 de 5 la quitan en este local (una marca en el navegador). Estilos en
 * panel-2.css.
 */
export function PrimerosPasos({ tenantId, onNavigate }: { tenantId: string; onNavigate: (key: TabKey) => void }) {
  const titleId = useId();
  const toast = useToast();
  const [hidden, setHidden] = useState(true);
  const [datos, setDatos] = useState<PrimerosPasosDatos | null>(null);

  useEffect(() => {
    if (readMark(primerosPasosKey(tenantId)) === HIDDEN) return undefined;
    setHidden(false);
    let cancelled = false;
    Promise.all([fetchCarta(), fetchOperators(), fetchOperators('WAITER'), fetchTotpStatus(), fetchNights()])
      .then(([carta, companeras, camareros, totp, noches]) => {
        if (cancelled) return;
        setDatos({
          carta: carta.length,
          companeras: companeras.length,
          camareros: camareros.length,
          formasVistas: readMark(primerosPasosFormasKey(tenantId)) !== null,
          dosPasos: totp.enabled,
          noches: noches.length,
        });
      })
      .catch(() => {
        // Si algo falla, la tarjeta no sale.
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const view = primerosPasos(datos, { oculto: hidden });

  // A 5 de 5: el aviso una vez y no vuelve a salir.
  const completo = view.visible && view.completo;
  useEffect(() => {
    if (!completo) return;
    writeMark(primerosPasosKey(tenantId), HIDDEN);
    setHidden(true);
    toast.show('Tu local está listo');
  }, [completo, tenantId, toast]);

  if (!view.visible || view.completo) return null;

  function hide(): void {
    writeMark(primerosPasosKey(tenantId), HIDDEN);
    setHidden(true);
  }

  return (
    <section className="np-pasos" aria-labelledby={titleId}>
      <div className="np-pasos-head">
        <h2 id={titleId} className="np-pasos-title">
          Deja listo tu local
        </h2>
        <span className="np-pasos-count">{view.texto}</span>
        <Button variant="quiet" size="sm" onClick={hide}>
          Ocultar
        </Button>
      </div>
      <ol className="np-pasos-list">
        {view.pasos.map((paso) => (
          <li key={paso.key} className="np-pasos-row" data-done={paso.done || undefined}>
            <span className="np-pasos-mark" aria-hidden="true">
              {paso.done ? <Icon name="check" size={20} /> : null}
            </span>
            <span className="np-pasos-label">
              {paso.label}
              {paso.done ? <span className="np-sr-only"> (hecho)</span> : null}
            </span>
            <Button variant="ghost" size="sm" className="np-pasos-go" onClick={() => onNavigate(paso.tab)} aria-label={`Ir: ${paso.label}`}>
              Ir
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
