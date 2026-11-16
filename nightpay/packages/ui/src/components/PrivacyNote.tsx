import type { CSSProperties } from 'react';

/**
 * El aviso de privacidad donde el personal da sus datos (al entrar y en el
 * alta): una línea pequeña con el enlace a /legal/privacidad#personal, que
 * sirve el API. `apiBase`: la URL del API de cada app (NEXT_PUBLIC_API_URL).
 */
export function PrivacyNote({ apiBase, lead = 'Cómo tratamos tus datos:' }: { apiBase: string; lead?: string }) {
  const href = `${apiBase.replace(/\/+$/, '')}/legal/privacidad?lang=es#personal`;
  return (
    <p style={noteStyle}>
      {lead}{' '}
      <a href={href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
        Política de privacidad
      </a>
    </p>
  );
}

const noteStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.75rem',
  lineHeight: 1.5,
  color: 'var(--np-text-mute)',
  textAlign: 'center',
};

const linkStyle: CSSProperties = { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '0.15em' };
