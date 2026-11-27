'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { CUSTOMER_DISPLAY_CODE_LENGTH, type CustomerDisplayCode, type CustomerDisplayStatus } from '@nightpay/contracts';
import { Button, FormError, Sheet, formatClock, useNow } from '@nightpay/ui';
import { createDisplayCode, fetchDisplayStatus, unpairDisplayFromStaff } from '@/lib/customer-display-api';

/** Mientras se enseña el código: ¿ya lo metió la tablet? Sin agobiar al API. */
const PAIRED_CHECK_MS = 4_000;

const hourOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

/** El botón; el paso 2 lo nombra igual. */
const pairLabel = (paired: boolean): string => (paired ? 'Emparejar otra' : 'Emparejar');

/** Los 3 pasos para emparejar la tablet. */
export function PairingSteps({ url, paired }: { url: string; paired: boolean }) {
  return (
    <ol style={steps} aria-label="Cómo emparejarla">
      <li>
        En la tablet, abre <strong>{url}</strong>.
      </li>
      <li>
        Aquí, toca <strong>«{pairLabel(paired)}»</strong>.
      </li>
      <li>En la tablet, escribe el código de {CUSTOMER_DISPLAY_CODE_LENGTH} letras y números que sale aquí.</li>
    </ol>
  );
}

/**
 * «Pantalla del cliente» (Menú): arriba, qué es y los 3 pasos para
 * emparejarla; emparejar la tablet de la barra con un código de 5 minutos,
 * ver hasta cuándo vale (12 h) y desemparejarla.
 */
export function CustomerDisplaySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<CustomerDisplayStatus | null>(null);
  const [code, setCode] = useState<CustomerDisplayCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(open && code !== null);
  const secondsLeft = code ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000)) : 0;
  const codeLive = code !== null && secondsLeft > 0;

  const load = useCallback(async () => {
    try {
      const next = await fetchDisplayStatus();
      setStatus(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se ha podido comprobar la pantalla.');
      return null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setCode(null);
    setStatus(null);
    void load();
  }, [open, load]);

  // Con el código en pantalla: en cuanto la tablet lo mete, «Emparejada».
  useEffect(() => {
    if (!open || !codeLive) return undefined;
    const pairedBefore = status?.pairedUntil ?? null;
    const id = setInterval(() => {
      void load().then((next) => {
        if (next?.paired && next.pairedUntil !== pairedBefore) setCode(null);
      });
    }, PAIRED_CHECK_MS);
    return () => clearInterval(id);
    // Solo al enseñar un código nuevo (status cambia con cada consulta: no reinicia la espera).
  }, [open, codeLive, load]);

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se ha podido. Vuelve a intentarlo.');
    } finally {
      setBusy(false);
    }
  }

  const pair = () => run(async () => setCode(await createDisplayCode()));
  const unpair = () =>
    run(async () => {
      await unpairDisplayFromStaff();
      setCode(null);
      await load();
    });

  const pantallaUrl = typeof window === 'undefined' ? '/pantalla' : `${window.location.host}/pantalla`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pantalla del cliente"
      footer={
        !codeLive || status?.paired ? (
          <div className="np-pregunta-pie">
            {status?.paired ? (
              <Button variant="ghost" onClick={() => void unpair()} disabled={busy}>
                Desemparejar
              </Button>
            ) : null}
            {!codeLive ? (
              <Button onClick={() => void pair()} loading={busy}>
                {pairLabel(status?.paired === true)}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div style={col}>
        <p style={text}>
          Una tablet en la barra, mirando al cliente (vale un móvil viejo). Cuando cobras, enseña el importe y el QR; ahí el
          cliente puede elegir la propina y pagar acercando su ficha. Sale «Pagado» y vuelve a reposo.
        </p>
        <p style={dim}>
          Nunca enseña el saldo ni tu nombre, y desde ella no se puede cancelar ni devolver. Se desempareja sola al cerrar la
          noche.
        </p>
        {/* Con el código ya en pantalla, sus propias instrucciones (abajo) bastan. */}
        {!codeLive ? (
          <PairingSteps url={pantallaUrl} paired={status?.paired === true} />
        ) : null}
        {codeLive ? (
          <>
            <p style={text}>
              En la tablet, abre <strong>{pantallaUrl}</strong> y escribe:
            </p>
            <p style={codeStyle} aria-label={`Código ${code.code.split('').join(' ')}`}>
              {code.code}
            </p>
            <p style={dim}>Caduca en {formatClock(secondsLeft)}</p>
          </>
        ) : status?.paired && status.pairedUntil ? (
          <p style={ok}>Emparejada hasta las {hourOf(status.pairedUntil)}.</p>
        ) : status ? (
          <p style={dim}>{code ? 'El código ha caducado. Pide otro.' : 'Sin pantalla emparejada.'}</p>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
      </div>
    </Sheet>
  );
}

const col: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const text: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)', lineHeight: 1.45 };
const dim: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };
const steps: CSSProperties = {
  margin: 0,
  paddingLeft: '1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  fontSize: 'var(--np-fs-16)',
  lineHeight: 1.4,
};
const ok: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)', fontWeight: 600 };
const codeStyle: CSSProperties = {
  margin: '0.25rem 0',
  textAlign: 'center',
  font: '700 var(--np-fs-40)/1 var(--np-font-num)',
  letterSpacing: '0.12em',
  padding: '1rem',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  background: 'var(--np-surface-2, var(--np-surface))',
};
