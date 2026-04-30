'use client';

import { useEffect, type CSSProperties, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, width = '28rem' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...content, width }}>
        {title ? <h3 style={titleStyle}>{title}</h3> : null}
        {children}
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'var(--np-backdrop)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1rem',
  zIndex: 100,
  animation: 'np-fade-in var(--np-d-base) var(--np-ease)',
};

const content: CSSProperties = {
  position: 'relative',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-lg)',
  padding: 'var(--np-s-6)',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxShadow: '0 32px 80px oklch(2% 0 0 / 0.6)',
  animation: 'np-modal-in var(--np-d-base) var(--np-ease)',
};

const titleStyle: CSSProperties = {
  margin: '0 0 var(--np-s-4)',
  fontSize: 'var(--np-t-h3)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--np-text)',
};
