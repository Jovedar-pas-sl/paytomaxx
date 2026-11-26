'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';

type Theme = 'dark' | 'light';
const STORAGE_KEY = 'np-theme';

function readTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

interface Props {
  size?: 'sm' | 'md';
}

export function ThemeToggle({ size = 'md' }: Props) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  }

  const side = size === 'sm' ? '2.25rem' : '2.75rem';
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
      title={isDark ? 'Modo claro' : 'Modo oscuro'}
      style={{
        ...btnBase,
        height: side,
        width: side,
        opacity: mounted ? 1 : 0,
      }}
    >
      <Icon name={isDark ? 'sun' : 'moon'} size={20} />
    </button>
  );
}

const btnBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  color: 'var(--np-text)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-pill)',
  cursor: 'pointer',
  transition:
    'background var(--np-d-fast), border-color var(--np-d-fast), color var(--np-d-fast), opacity var(--np-d-base)',
  flexShrink: 0,
};
