import type { CSSProperties, ReactNode } from 'react';

interface StageProps {
  children: ReactNode;
  centered?: boolean;
}

/** Full-viewport scene used by the customer-facing pay page. */
export function Stage({ children, centered = true }: StageProps) {
  return (
    <main
      className="np-app-root np-screen"
      style={{
        ...wrap,
        justifyContent: centered ? 'center' : 'flex-start',
      }}
    >
      {children}
    </main>
  );
}

interface MetaProps {
  venue: string;
  terminal?: string;
}

export function StageMeta({ venue, terminal }: MetaProps) {
  return (
    <header style={metaWrap}>
      <span style={metaVenue}>{venue}</span>
      {terminal ? <span style={metaTerm}>{terminal}</span> : null}
    </header>
  );
}

const wrap: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: 'var(--np-s-7) var(--np-s-5) var(--np-s-6)',
  gap: 'var(--np-s-5)',
  maxWidth: '32rem',
  margin: '0 auto',
};

const metaWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.25rem',
  textAlign: 'center',
};

const metaVenue: CSSProperties = {
  fontSize: 'var(--np-fs-14)',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
};

const metaTerm: CSSProperties = {
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-dim)',
};
