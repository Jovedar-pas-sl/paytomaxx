'use client';

import { useState, type ReactNode } from 'react';
import { PASSKEY_REQUIRED_CODE, type StepUpProof } from '@nightpay/contracts';
import { ApiError, totpRetryState } from '@/lib/api-errors';
import type { SecondFactor } from '@/lib/endpoints/partner-connections';
import { OTP_LENGTH } from '@/lib/otp';
import { proofFor } from '@/lib/refund-confirm';
import { useStepUpMethod } from '@/lib/use-step-up-method';
import { KeyConfirm } from '../../KeyConfirm';
import { OtpInput } from '../../OtpInput';

export interface SecondFactorState {
  /** El campo: el código de la 2FA o «Confirmar con Face ID». */
  field: ReactNode;
  ready: boolean;
  factor: SecondFactor;
  /** Tras un fallo: borra el código (ya se gastó) y dice qué hacer. */
  failed: (err: unknown) => string;
  /** Tras el éxito: la prueba de la llave vale una vez. */
  spent: () => void;
}

/**
 * El segundo factor que pide el API para crear, cambiar o reanudar una
 * clave, anular una carga o subir los topes: el código de la 2FA o, sin 2FA, la llave de acceso para esa acción
 * (stepUpActions.partner). El código se borra tras cada intento: el API lo
 * gasta antes de mirar lo demás.
 */
export function useSecondFactor(
  action: string | null,
  active: boolean,
  next: string,
  reason = 'Para la clave de una plataforma.',
): SecondFactorState {
  const method = useStepUpMethod(active);
  const [askedForKey, setAskedForKey] = useState(false);
  const [proof, setProof] = useState<StepUpProof | null>(null);
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const withKey = method === 'passkey' || askedForKey;
  const keyProof = withKey ? proofFor(proof, action, Date.now()) : null;

  const field = withKey ? (
    <KeyConfirm action={action} confirmed={Boolean(keyProof)} onProof={setProof} reason={reason} next={next} />
  ) : (
    <OtpInput
      label="Código de tu app de verificación (2FA)"
      value={code}
      onChange={setCode}
      autoSubmit={false}
      lockedUntil={lockedUntil}
      required
      hint="Si aún no la tienes, actívala en Ajustes → Seguridad."
    />
  );

  return {
    field,
    ready: withKey ? Boolean(keyProof) : code.length === OTP_LENGTH,
    factor: withKey ? { stepUpToken: keyProof?.token } : { totpCode: code },
    failed(err) {
      setCode('');
      setProof(null);
      if (err instanceof ApiError && err.code === PASSKEY_REQUIRED_CODE) {
        setAskedForKey(true);
        return `Confírmalo con tu llave de acceso. ${next}`;
      }
      setLockedUntil(totpRetryState(err, Date.now()).lockedUntil);
      return err instanceof Error && err.message ? err.message : 'No se pudo hacer. Vuelve a probar.';
    },
    spent() {
      setCode('');
      setProof(null);
    },
  };
}
