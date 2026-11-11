'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import type { OperatorUser } from '@/lib/api';
import { shouldCollapseSheet } from '@/lib/session-resume';
import { LoginForm } from './LoginForm';
import styles from './money.module.css';

interface Props {
  /** El email de quien estaba (se puede cambiar: otra persona empieza de cero). */
  email: string;
  /** Algún cobro sigue esperando: al dejar de esperar, la hoja se recoge y se ve el resultado. */
  chargePending: boolean;
  onSuccess: (user: OperatorUser) => void;
}

/**
 * La sesión caducó con un cobro abierto: se entra otra vez aquí, encima, y
 * debajo el QR, su cuenta atrás y el «PAGADO» siguen funcionando. Se puede
 * recoger («Ver el cobro») para que el cliente escanee el QR entero. El
 * formulario no se desmonta al recogerla: lo tecleado no se pierde.
 */
export function ReloginSheet({ email, chargePending, onSuccess }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const wasPending = useRef(chargePending);
  const titleId = useId();

  useEffect(() => {
    if (shouldCollapseSheet(wasPending.current, chargePending)) setCollapsed(true);
    wasPending.current = chargePending;
  }, [chargePending]);

  return (
    <div role="dialog" aria-labelledby={titleId} className={styles.sheet} data-collapsed={collapsed}>
      {collapsed ? (
        <div style={barStyle}>
          <div style={{ minWidth: 0 }}>
            <p id={titleId} style={barTitle}>
              Sesión caducada
            </p>
            <p style={barHint}>Entra otra vez para seguir.</p>
          </div>
          <Button size="md" onClick={() => setCollapsed(false)} style={{ height: '3rem', flexShrink: 0 }}>
            Entrar
          </Button>
        </div>
      ) : null}
      <div hidden={collapsed} style={collapsed ? undefined : bodyStyle}>
        <div style={headStyle}>
          <p style={kicker}>
            <span aria-hidden style={dot} />
            Sesión caducada
          </p>
          <button type="button" className={styles.peek} onClick={() => setCollapsed(true)}>
            Ver el cobro ↓
          </button>
        </div>
        <h2 id={collapsed ? undefined : titleId} style={titleStyle}>
          Tu sesión ha caducado. Entra otra vez para seguir.
        </h2>
        <p style={hintStyle}>El cobro sigue abierto: el QR, la cuenta atrás y el «PAGADO» siguen funcionando.</p>
        <LoginForm initialEmail={email} submitLabel="Entrar y seguir" onSuccess={onSuccess} />
      </div>
    </div>
  );
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
};

const kicker: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-warning)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const dot: CSSProperties = {
  width: '0.5rem',
  height: '0.5rem',
  borderRadius: '50%',
  background: 'currentColor',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-22)',
  fontWeight: 700,
  lineHeight: 1.25,
  letterSpacing: '-0.01em',
};

const hintStyle: CSSProperties = {
  margin: '0 0 0.25rem',
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
};

const barTitle: CSSProperties = {
  margin: 0,
  fontWeight: 700,
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-warning)',
};

const barHint: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-mute)',
};
