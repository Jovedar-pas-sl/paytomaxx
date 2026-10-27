// Guardar un archivo que da el API (CSV) o abrir una página para imprimir /
// guardar en PDF (el documento de una liquidación). Las descargas van con la
// sesión (cabecera Authorization): no se puede abrir la URL del API sin más.

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * La pestaña se abre al pulsar (antes de esperar al API): si se abriera
 * después, el navegador la bloquearía como ventana emergente.
 */
export function openPendingWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  const win = window.open('', '_blank');
  if (win) {
    win.document.title = 'Preparando…';
    win.document.body.textContent = 'Preparando el documento…';
  }
  return win;
}

/** La página en la pestaña ya abierta; si el navegador no la dejó abrir, se guarda como archivo. */
export function showPrintable(win: Window | null, blob: Blob, filename: string): 'opened' | 'saved' {
  const page = new Blob([blob], { type: 'text/html;charset=utf-8' });
  if (win && !win.closed) {
    const url = URL.createObjectURL(page);
    win.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'opened';
  }
  saveBlob(page, filename);
  return 'saved';
}
