'use client';

import type { ReactNode } from 'react';
import { Sheet } from './Sheet';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string;
}

/**
 * La ventana de siempre, que hoy es la hoja (Sheet): desde abajo en el móvil y
 * centrada en una pantalla ancha. Se cierra con Esc, «atrás», arrastrando o con
 * la ✕, no al pulsar fuera: un toque sin querer no se lleva lo que se estaba
 * escribiendo. Lo nuevo usa Sheet (título obligatorio y pie fijo).
 */
export function Modal({ open, onClose, title, children, width }: ModalProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title ?? ''} width={width}>
      {children}
    </Sheet>
  );
}
