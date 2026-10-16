'use client';

import { useState } from 'react';
import { Modal } from '@nightpay/ui';
import type { ResetStaffPasswordResponse, StaffUserView } from '@nightpay/contracts';
import { formatDateTime } from '@/lib/dates';
import {
  disableSaUser,
  enableSaUser,
  resetSaUserPassword,
  resetSaUserTotp,
  revokeSaUserSessions,
  setSaSuperAdmin,
} from '@/lib/endpoints/superadmin';
import { SA_ROLE_LABELS, personName } from '@/lib/superadmin/labels';
import type { SaAction } from '@/lib/superadmin/step-up';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { useSa } from './context';
import { ResultDialog, StepUpDialog, type StepUpValues } from './StepUpDialog';
import { SecretBox } from './ui';

type PersonAction = 'reset' | 'disable' | 'enable' | 'sessions' | 'totp' | 'grantSa' | 'revokeSa';

interface ActionSpec {
  label: string;
  /** Qué pasa, en una línea (en la lista de acciones). */
  help: string;
  action: SaAction;
  danger?: boolean;
  /** Frase de confirmación. */
  summary: (name: string) => string;
}

const ACTIONS: Readonly<Record<PersonAction, ActionSpec>> = {
  reset: {
    label: 'Restablecer contraseña',
    help: 'Sin cuenta activada: invitación nueva. Ya activada: contraseña temporal que verás una vez.',
    action: 'user.resetPassword',
    summary: (n) => `Vas a restablecer la contraseña de ${n}. Se le cierran las sesiones abiertas.`,
  },
  disable: {
    label: 'Dar de baja',
    help: 'No podrá entrar y se le cierran las sesiones.',
    action: 'user.disable',
    danger: true,
    summary: (n) => `Vas a dar de baja a ${n}: no podrá entrar y se le cierran las sesiones.`,
  },
  enable: {
    label: 'Dar de alta otra vez',
    help: 'Podrá volver a entrar con su contraseña.',
    action: 'user.enable',
    summary: (n) => `Vas a dar de alta otra vez a ${n}: podrá volver a entrar.`,
  },
  sessions: {
    label: 'Cerrar sesiones',
    help: 'La saca de todos sus móviles y ordenadores. No pide 2FA.',
    action: 'user.revokeSessions',
    summary: (n) =>
      `Vas a cerrar todas las sesiones de ${n}. Tendrá que volver a entrar (lo que tenga abierto caduca en menos de 1 hora).`,
  },
  totp: {
    label: 'Quitar su 2FA',
    help: 'Para quien perdió el móvil: tendrá que activarla otra vez.',
    action: 'user.resetTotp',
    danger: true,
    summary: (n) => `Vas a quitar la verificación en dos pasos de ${n}: tendrá que activarla otra vez. Se le cierran las sesiones.`,
  },
  grantSa: {
    label: 'Dar permiso de super-admin',
    help: 'Verá y podrá cambiar todos los negocios y locales.',
    action: 'user.superAdmin',
    danger: true,
    summary: (n) => `Vas a dar el permiso de super-admin a ${n}: verá y podrá cambiar todos los negocios y locales.`,
  },
  revokeSa: {
    label: 'Quitar permiso de super-admin',
    help: 'Vuelve a ver solo su local.',
    action: 'user.superAdmin',
    summary: (n) => `Vas a quitar el permiso de super-admin a ${n}: volverá a ver solo su local.`,
  },
};

/** Qué acciones tiene esta persona (según su estado y si eres tú). */
function availableActions(p: StaffUserView, selfId: string): PersonAction[] {
  const self = p.id === selfId;
  return [
    'reset' as const,
    p.active ? (self ? null : ('disable' as const)) : ('enable' as const),
    p.active ? ('sessions' as const) : null,
    p.totpEnabled && !self ? ('totp' as const) : null,
    p.isSuperAdmin ? ('revokeSa' as const) : p.role === 'OWNER' && p.active ? ('grantSa' as const) : null,
  ].filter((a): a is PersonAction => a !== null);
}

interface Props {
  person: StaffUserView;
  onUpdated: (user: StaffUserView) => void;
  onClose: () => void;
}

/** Acciones sobre una persona: la lista y, al elegir una, su confirmación con 2FA. */
export function PersonActionsDialog({ person, onUpdated, onClose }: Props) {
  const sa = useSa();
  const [chosen, setChosen] = useState<PersonAction | null>(null);
  const [password, setPassword] = useState<ResetStaffPasswordResponse | null>(null);
  const [revoked, setRevoked] = useState<number | null>(null);
  const name = personName(person);

  if (password) {
    return (
      <ResultDialog title="Contraseña restablecida" onClose={onClose}>
        {password.kind === 'password' ? (
          <PasswordResult who={name} password={password.password} />
        ) : (
          <InviteResult who={name} url={password.inviteUrl} expiresAt={password.expiresAt} emailSent={null} />
        )}
      </ResultDialog>
    );
  }

  if (revoked !== null) {
    return (
      <ResultDialog title="Sesiones cerradas" onClose={onClose}>
        <Notice tone="success">
          {revoked === 1 ? 'Se cerró 1 sesión' : `Se cerraron ${revoked} sesiones`} de {name}.
        </Notice>
      </ResultDialog>
    );
  }

  if (chosen) {
    const spec = ACTIONS[chosen];
    return (
      <StepUpDialog
        title={spec.label}
        action={spec.action}
        summary={spec.summary(name)}
        submitLabel={spec.label}
        danger={spec.danger}
        reasonPlaceholder="Por ejemplo: perdió el móvil"
        onSubmit={async (values) => {
          const result = await runAction(chosen, person, values);
          if (result.kind === 'user') {
            onUpdated(result.user);
            onClose();
          } else if (result.kind === 'password') {
            setPassword(result.response);
          } else {
            setRevoked(result.revoked);
          }
        }}
        onClose={() => setChosen(null)}
      />
    );
  }

  const actions = availableActions(person, sa.currentUserId);
  return (
    <Modal open onClose={onClose} title={name} width="30rem">
      <div className="np-sa-form">
        <p className="np-sa-text">
          {SA_ROLE_LABELS[person.role]} en {person.venue.name} · {person.email}
        </p>
        <ul className="np-sa-action-list">
          {actions.map((a) => (
            <li key={a}>
              <button
                type="button"
                className="np-sa-action"
                data-danger={ACTIONS[a].danger ? 'true' : undefined}
                onClick={() => setChosen(a)}
              >
                <span className="np-sa-action-label">{ACTIONS[a].label}</span>
                <span className="np-sa-action-help">{ACTIONS[a].help}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="np-sa-action"
              onClick={() => {
                sa.openAuditFor({ id: person.id, label: name });
                onClose();
              }}
            >
              <span className="np-sa-action-label">Ver lo que ha hecho</span>
              <span className="np-sa-action-help">Abre el registro con sus acciones.</span>
            </button>
          </li>
        </ul>
      </div>
    </Modal>
  );
}

type ActionResult =
  | { kind: 'user'; user: StaffUserView }
  | { kind: 'password'; response: ResetStaffPasswordResponse }
  | { kind: 'sessions'; revoked: number };

async function runAction(action: PersonAction, p: StaffUserView, v: StepUpValues): Promise<ActionResult> {
  const input = { totpCode: v.totpCode, reason: v.reason };
  switch (action) {
    case 'reset':
      return { kind: 'password', response: await resetSaUserPassword(p.id, input) };
    case 'disable':
      return { kind: 'user', user: await disableSaUser(p.id, input) };
    case 'enable':
      return { kind: 'user', user: await enableSaUser(p.id, input) };
    case 'sessions':
      return { kind: 'sessions', revoked: (await revokeSaUserSessions(p.id, v.reason)).revoked };
    case 'totp':
      return { kind: 'user', user: await resetSaUserTotp(p.id, input) };
    case 'grantSa':
      return { kind: 'user', user: await setSaSuperAdmin(p.id, true, input) };
    case 'revokeSa':
      return { kind: 'user', user: await setSaSuperAdmin(p.id, false, input) };
  }
}

/** Contraseña temporal: se ve UNA vez. */
export function PasswordResult({ who, password }: { who: string; password: string }) {
  return (
    <>
      <Notice tone="warning">
        <strong>Solo se ve ahora.</strong> Cópiala y pásasela a {who} por un canal seguro. Si se pierde, habrá que
        restablecerla otra vez.
      </Notice>
      <SecretBox label="Contraseña temporal" value={password} big />
    </>
  );
}

/** Enlace de invitación (24 h) para que ponga su contraseña. */
export function InviteResult({
  who,
  url,
  expiresAt,
  emailSent,
}: {
  who: string;
  url: string;
  expiresAt: string;
  /** null = no se sabe (restablecer). */
  emailSent: boolean | null;
}) {
  const tz = useVenueTimezone();
  return (
    <>
      <p className="np-sa-text">
        {who} tiene que abrir este enlace para poner su contraseña. Vale hasta el{' '}
        {formatDateTime(expiresAt, tz, 'datetime')}.
      </p>
      {emailSent === false ? (
        <Notice tone="warning">No se pudo mandar el email: pásale el enlace por WhatsApp.</Notice>
      ) : emailSent ? (
        <Notice tone="success">También se le ha mandado por email.</Notice>
      ) : null}
      <SecretBox label="Enlace de invitación" value={url} />
    </>
  );
}
