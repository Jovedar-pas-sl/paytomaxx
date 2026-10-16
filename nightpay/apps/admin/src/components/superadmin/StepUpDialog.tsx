'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Input, Modal } from '@nightpay/ui';
import { OTP_LENGTH } from '@/lib/otp';
import {
  NOT_ENROLLED_MESSAGE,
  SA_ACTION_RULES,
  describeSaFailure,
  reasonProblem,
  type SaAction,
} from '@/lib/superadmin/step-up';
import { useLockActive } from '@/lib/use-lock';
import { ConfirmLine } from '../ConfirmLine';
import { Notice } from '../Notice';
import { OtpInput } from '../OtpInput';
import { useSa } from './context';
import { ErrorLine, StickyActions } from './ui';

export interface StepUpValues {
  /** '' si la acción no pide 2FA. */
  totpCode: string;
  /** '' si no se puso (o no se pide). */
  reason: string;
}

interface Props {
  title: string;
  /** Qué pide (2FA y motivo): SA_ACTION_RULES. */
  action: SaAction;
  /** Frase de una línea antes de confirmar: «Vas a pausar Luna Valencia. …». */
  summary: string;
  /** Explicación o aviso encima (p. ej. qué hace la pausa). */
  intro?: ReactNode;
  /** Campos propios de la acción (IBAN, cuenta…), antes del motivo. */
  children?: ReactNode;
  /** Comprobación de esos campos; null si valen. */
  validate?: () => string | null;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  submitLabel: string;
  danger?: boolean;
  width?: string;
  /** Hace la llamada. Si lanza, el error se enseña y el diálogo sigue abierto. */
  onSubmit: (values: StepUpValues) => Promise<void>;
  onClose: () => void;
}

/**
 * Confirmar una acción delicada de la consola: frase de resumen
 * (ConfirmLine), motivo si lo pide y el código 2FA en 6 casillas (se envía
 * solo al poner la sexta cifra). Los fallos 2FA se explican en llano: sin
 * 2FA → a Ajustes; código malo → «cambia cada 30 s»; demasiados → bloqueado
 * hasta una hora (para todos los diálogos: es de la persona).
 */
export function StepUpDialog({
  title,
  action,
  summary,
  intro,
  children,
  validate,
  reasonLabel = 'Motivo (queda en el registro)',
  reasonPlaceholder = 'Por ejemplo: impago de la cuota de octubre',
  submitLabel,
  danger,
  width = '32rem',
  onSubmit,
  onClose,
}: Props) {
  const rule = SA_ACTION_RULES[action];
  const sa = useSa();
  const locked = useLockActive(sa.lockedUntil);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notEnrolled, setNotEnrolled] = useState(false);

  const blockedByEnrolment = rule.totp && (sa.totpEnabled === false || notEnrolled);
  const fieldsProblem = (): string | null => validate?.() ?? reasonProblem(reason, rule.reason);
  const ready = fieldsProblem() === null;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    const problem = fieldsProblem();
    if (problem) return setError(problem);
    if (rule.totp && code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ totpCode: rule.totp ? code : '', reason: reason.trim() });
    } catch (err) {
      const failure = describeSaFailure(err, Date.now());
      if (failure.lockedUntil !== null) sa.setLockedUntil(failure.lockedUntil);
      if (failure.notEnrolled) setNotEnrolled(true);
      if (failure.clearCode) setCode('');
      setError(failure.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title={title} width={width}>
      <form className="np-sa-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        {blockedByEnrolment ? (
          <Notice tone="warning" action={{ label: 'Ir a Ajustes', onClick: sa.goToSettings }}>
            {NOT_ENROLLED_MESSAGE}
          </Notice>
        ) : null}
        {intro}
        {children}
        {rule.reason !== 'none' ? (
          <Input
            label={rule.reason === 'optional' ? `${reasonLabel} · opcional` : reasonLabel}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            maxLength={500}
            autoComplete="off"
            required={rule.reason === 'required'}
            disabled={submitting}
          />
        ) : null}
        <ConfirmLine>{summary}</ConfirmLine>
        {rule.totp ? (
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={code}
            onChange={setCode}
            autoSubmit={ready && !blockedByEnrolment}
            lockedUntil={sa.lockedUntil}
            disabled={submitting || blockedByEnrolment}
            required
            hint={
              ready
                ? 'Al poner el sexto número se confirma. Cada código vale una vez (cambia cada 30 s).'
                : 'Rellena lo de arriba; luego, al poner el sexto número, se confirma.'
            }
          />
        ) : null}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <StickyActions>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={danger ? 'danger' : 'primary'}
            loading={submitting}
            disabled={(rule.totp && locked) || blockedByEnrolment}
          >
            {submitLabel}
          </Button>
        </StickyActions>
      </form>
    </Modal>
  );
}

/** Resultado que solo se ve una vez (contraseña, enlace): con «Hecho» para cerrar. */
export function ResultDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={title} width="32rem">
      <div className="np-sa-form">
        {children}
        <StickyActions>
          <Button type="button" onClick={onClose}>
            Hecho
          </Button>
        </StickyActions>
      </div>
    </Modal>
  );
}
