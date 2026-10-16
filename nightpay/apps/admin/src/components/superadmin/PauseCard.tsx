'use client';

import { useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import type { StepUpInput } from '@/lib/endpoints/superadmin';
import { PAUSE_EFFECT, pauseLine } from '@/lib/superadmin/labels';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { StepUpDialog, type StepUpValues } from './StepUpDialog';
import { SectionHead, StickyActions } from './ui';

interface Props {
  kind: 'business' | 'venue';
  name: string;
  paused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
  /** Local que no cobra porque su negocio está en pausa. */
  pausedByBusiness?: boolean;
  /** Negocio: cuántos locales se quedan sin cobrar. */
  venueCount?: number;
  onPause: (input: StepUpInput) => Promise<void>;
  onResume: (input: StepUpInput) => Promise<void>;
}

const toInput = ({ totpCode, reason }: StepUpValues): StepUpInput => ({
  totpCode,
  ...(reason ? { reason } : {}),
});

/**
 * Pausa de un negocio o un local: estado («En pausa desde … por …») y el
 * botón. Antes de pausar se dice qué deja de funcionar y qué sigue.
 */
export function PauseCard(props: Props) {
  const { kind, name, paused, pausedAt, pausedReason, pausedByBusiness, venueCount } = props;
  const tz = useVenueTimezone();
  const [dialog, setDialog] = useState<'pause' | 'resume' | null>(null);
  const what = kind === 'business' ? 'el negocio' : 'el local';
  const venuesText =
    kind === 'business' && venueCount !== undefined
      ? ` (${venueCount === 1 ? 'su local' : `sus ${venueCount} locales`})`
      : '';

  return (
    <Card>
      <div className="np-sa-stack-sm">
        <SectionHead level={3} title="Pausa" />
        {paused ? (
          <p className="np-sa-status-line">
            <Pill tone="warning">En pausa</Pill> {pauseLine(pausedAt, pausedReason, tz)}
          </p>
        ) : pausedByBusiness ? (
          <p className="np-sa-status-line">
            <Pill tone="warning">En pausa (negocio)</Pill> Su negocio está en pausa: este local no cobra hasta que se
            quite allí.
          </p>
        ) : (
          <p className="np-sa-status-line">
            <Pill tone="success">Cobrando</Pill> Funciona con normalidad.
          </p>
        )}
        <StickyActions sticky={false}>
          {paused ? (
            <Button type="button" onClick={() => setDialog('resume')}>
              Quitar la pausa
            </Button>
          ) : (
            <Button type="button" variant="danger" onClick={() => setDialog('pause')}>
              Pausar {what}
            </Button>
          )}
        </StickyActions>
      </div>

      {dialog === 'pause' ? (
        <StepUpDialog
          title={`Pausar ${what}`}
          action={kind === 'business' ? 'business.pause' : 'venue.pause'}
          summary={`Vas a pausar ${name}${venuesText}. ${PAUSE_EFFECT}`}
          submitLabel={`Pausar ${what}`}
          danger
          onSubmit={async (values) => {
            await props.onPause(toInput(values));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'resume' ? (
        <StepUpDialog
          title="Quitar la pausa"
          action={kind === 'business' ? 'business.resume' : 'venue.resume'}
          summary={
            kind === 'business'
              ? `Vas a quitar la pausa de ${name}: sus locales vuelven a cobrar (menos los que tengan su propia pausa).`
              : `Vas a quitar la pausa de ${name}: vuelve a cobrar y a recargar saldo (si su negocio no sigue en pausa).`
          }
          reasonPlaceholder="Por ejemplo: cuota pagada"
          submitLabel="Quitar la pausa"
          onSubmit={async (values) => {
            await props.onResume(toInput(values));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Card>
  );
}
