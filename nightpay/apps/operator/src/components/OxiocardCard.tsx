'use client';

import { useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import type { OxiocardView } from '@nightpay/contracts';
import { oxiocardText, requestMyOxiocard } from '@/lib/oxiocard';

interface Props {
  view: OxiocardView;
  onChange: (view: OxiocardView) => void;
}

/** Su OxioCard en «Ganancias»: cómo va y, si no la ha pedido, «Abrir mi OxioCard». */
export function OxiocardCard({ view, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = oxiocardText(view);

  async function request() {
    setBusy(true);
    setError(null);
    try {
      onChange(await requestMyOxiocard());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="oxiocard-t" style={boxStyle}>
      <h2 id="oxiocard-t" style={titleStyle}>
        OxioCard <span style={stateStyle}>· {t.state}</span>
      </h2>
      <p style={textStyle}>{t.text}</p>
      {t.canRequest ? (
        <Button onClick={() => void request()} loading={busy} style={{ marginTop: '0.75rem' }}>
          Abrir mi OxioCard
        </Button>
      ) : null}
      {error ? (
        <p role="alert" style={{ ...textStyle, color: 'var(--np-danger)' }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

const boxStyle: CSSProperties = {
  padding: '0.875rem 1rem',
  background: 'var(--np-surface)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 600, color: 'var(--np-text)' };

const stateStyle: CSSProperties = { color: 'var(--np-text-mute)', fontWeight: 500 };

const textStyle: CSSProperties = { margin: '0.375rem 0 0', fontSize: 'var(--np-fs-16)', color: 'var(--np-text-mute)', lineHeight: 1.5 };
