'use client';

import { useState } from 'react';
import { Banner, Button, FieldError, Sheet, formatDateTime, useConfirm, useToast } from '@nightpay/ui';
import type { PartnerKeyIssued } from '@nightpay/contracts';
import { RETRY_ISSUE_LABEL, issuedOutcome, type IssuedOutcome } from '@/lib/partner-connections';

const HIDDEN = '•'.repeat(24);

/**
 * Lo que se ve una vez tras conectar o cambiar la clave: la clave con
 * «Copiar» (con «La copio yo»), o a quién llegó el enlace de un solo uso.
 * La clave vive solo en el estado de esta hoja: al cerrarla, quien la abrió
 * la suelta (setIssued(null)) y no queda en ningún sitio.
 */
export function KeyIssuedBody({
  outcome,
  partnerName,
  keyHint,
  timezone,
  shown,
  copyFailed = false,
  onToggle,
  onCopy,
  onRotate,
}: {
  outcome: IssuedOutcome;
  partnerName: string;
  keyHint: string;
  timezone: string;
  shown: boolean;
  /** El portapapeles no dejó: que la copie a mano. */
  copyFailed?: boolean;
  onToggle: () => void;
  onCopy: () => void;
  /** Con el correo fallido: conectar o cambiar la clave otra vez. */
  onRotate?: () => void;
}) {
  if (outcome.kind === 'key') {
    return (
      <div className="np-ptn-form">
        <p className="np-ptn-lead">
          Cópiala ahora y pásasela a {partnerName}: no se puede volver a ver. Que la guarde en su servidor, nunca en un cajero.
        </p>
        <div className="np-ptn-keybox">
          <span className="np-ptn-label">La clave</span>
          <code className="np-ptn-key" aria-label={shown ? undefined : 'Clave oculta'}>
            {shown ? outcome.key : HIDDEN}
          </code>
          <span className="np-ptn-help">Termina en {keyHint.slice(-4)}.</span>
          {copyFailed ? <FieldError>No se pudo copiar: selecciónala y cópiala a mano.</FieldError> : null}
          <div className="np-ptn-actions">
            <Button type="button" onClick={onCopy}>
              Copiar
            </Button>
            <Button type="button" variant="ghost" onClick={onToggle}>
              {shown ? 'Ocultar' : 'Ver'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (outcome.kind === 'sent') {
    return (
      <div className="np-ptn-form">
        <p className="np-ptn-lead">
          Le hemos enviado a {outcome.sentTo ?? 'su correo'} un enlace que se abre una sola vez
          {outcome.expiresAt ? ` y caduca el ${formatDateTime(outcome.expiresAt, timezone, 'short')}` : ' y caduca en 24 horas'}. Tú no ves
          la clave.
        </p>
        <p className="np-ptn-help">Si no le llega o caduca sin abrirlo, cambia la clave y vuelve a enviarlo.</p>
      </div>
    );
  }
  return (
    <div className="np-ptn-form">
      <Banner
        tone="danger"
        title="El correo no salió"
        action={onRotate ? { label: RETRY_ISSUE_LABEL, onClick: onRotate } : undefined}
      >
        No ha cambiado nada: todo sigue como antes. Inténtalo otra vez o elige «La copio yo».
      </Banner>
    </div>
  );
}

export function KeyIssuedSheet({
  issued,
  timezone,
  onClose,
  onRotate,
}: {
  issued: PartnerKeyIssued;
  timezone: string;
  /** Quien la abrió suelta la respuesta (y con ella la clave). */
  onClose: () => void;
  onRotate: () => void;
}) {
  const outcome = issuedOutcome(issued);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();

  async function copy(): Promise<void> {
    if (outcome.kind !== 'key') return;
    try {
      await navigator.clipboard.writeText(outcome.key);
      setCopied(true);
      setCopyFailed(false);
      toast.show('Clave copiada. Pégala donde la vaya a guardar la plataforma.', { tone: 'success' });
    } catch {
      setShown(true);
      setCopyFailed(true);
    }
  }

  async function close(): Promise<void> {
    if (outcome.kind === 'key' && !copied) {
      const sure = await confirm({
        title: '¿Ya la has guardado?',
        body: 'Al cerrar, la clave no se puede volver a ver. Si no la tienes, tendrás que cambiarla.',
        confirmLabel: 'Cerrar',
        cancelLabel: 'Volver',
        tone: 'danger',
      });
      if (!sure) return;
    }
    setShown(false);
    onClose();
  }

  const title =
    outcome.kind === 'key'
      ? `La clave de ${issued.connection.partnerName}`
      : outcome.kind === 'sent'
        ? 'Enlace enviado'
        : 'No se pudo enviar';
  return (
    <>
      <Sheet
        open
        title={title}
        onClose={() => void close()}
        full
        width="34rem"
        footer={
          <Button type="button" onClick={() => void close()}>
            {outcome.kind === 'key' ? 'Ya la he guardado' : 'Hecho'}
          </Button>
        }
      >
        <KeyIssuedBody
          outcome={outcome}
          partnerName={issued.connection.partnerName}
          keyHint={issued.connection.keyHint}
          timezone={timezone}
          shown={shown}
          copyFailed={copyFailed}
          onToggle={() => setShown((s) => !s)}
          onCopy={() => void copy()}
          onRotate={
            outcome.kind === 'failed'
              ? () => {
                  setShown(false);
                  onRotate();
                }
              : undefined
          }
        />
      </Sheet>
      {confirmDialog}
    </>
  );
}
