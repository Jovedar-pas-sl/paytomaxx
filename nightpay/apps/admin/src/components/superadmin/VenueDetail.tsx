'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import type { VenueDetail } from '@nightpay/contracts';
import { useVenueSwitch } from '../VenueSwitchDialog';
import { formatDateTime } from '@/lib/dates';
import {
  clearSaSettlementAccount,
  fetchSaVenue,
  pauseSaVenue,
  resumeSaVenue,
  setSaSettlementAccount,
  updateSaVenueProfile,
} from '@/lib/endpoints/superadmin';
import { profileFormFrom, profilePayload, type ProfileChange, type ProfileForm } from '@/lib/superadmin/forms';
import { formatIbanInput, holderProblem, ibanProblem, maskedIban } from '@/lib/superadmin/iban';
import { VAT_REGIME_LABELS, venuePauseLabel } from '@/lib/superadmin/labels';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { useSa } from './context';
import { PauseCard } from './PauseCard';
import { StepUpDialog } from './StepUpDialog';
import { BackButton, ErrorLine, Help, LoadGate, MetaList, SectionHead, SmallButton, StickyActions } from './ui';
import { useLoad } from './use-load';
import { VenueRulesCard } from './VenueRulesCard';

interface Props {
  venueId: string;
  onBack: () => void;
}

/** Ficha de un local: perfil, reglas, IBAN y pausa. */
export function VenueDetailView({ venueId, onBack }: Props) {
  const detail = useLoad((signal) => fetchSaVenue(venueId, signal), [venueId]);
  const sa = useSa();
  const tz = useVenueTimezone();

  function replace(next: VenueDetail): void {
    detail.setData(next);
    sa.refreshLists();
  }

  return (
    <div className="np-sa-stack np-sa-detail">
      <BackButton onClick={onBack}>Todos los locales</BackButton>
      <LoadGate loaded={detail} what="el local">
        {(v) => {
          const pause = venuePauseLabel(v);
          return (
            <>
              <SectionHead
                kicker="Local"
                title={v.name}
                sub={<span className="np-sa-mono">{v.slug}</span>}
                actions={
                  <>
                    {pause ? <Pill tone="warning">{pause}</Pill> : <Pill tone="success">Cobrando</Pill>}
                    <GoToVenueButton venueId={v.id} venueName={v.name} isCurrent={v.slug === sa.currentSlug} />
                  </>
                }
              />
              <MetaList
                items={[
                  ['Negocio', v.business?.name ?? 'Sin negocio'],
                  ['Alta', formatDateTime(v.createdAt, tz, 'date')],
                  ['Personas', v.counts.users],
                  ['Chicas', v.counts.operators],
                  ['Datáfonos', v.counts.terminals],
                ]}
              />
              <ProfileCard venue={v} onSaved={replace} />
              <VenueRulesCard venue={v} onSaved={replace} />
              <IbanCard venue={v} onSaved={replace} />
              <PauseCard
                kind="venue"
                name={v.name}
                paused={v.pausedBy === 'venue'}
                pausedAt={v.pausedAt}
                pausedReason={v.pausedReason}
                pausedByBusiness={v.pausedBy === 'business'}
                onPause={async (input) => replace(await pauseSaVenue(v.id, input))}
                onResume={async (input) => replace(await resumeSaVenue(v.id, input))}
              />
            </>
          );
        }}
      </LoadGate>
    </div>
  );
}

/** Cambiar el local activo del panel a este (como el desplegable de arriba; la 2FA se pidió al entrar). */
function GoToVenueButton({ venueId, venueName, isCurrent }: { venueId: string; venueName: string; isCurrent: boolean }) {
  const switcher = useVenueSwitch();
  if (isCurrent) return <Pill tone="info">Estás aquí</Pill>;

  return (
    <>
      <SmallButton onClick={() => switcher.start(venueId, venueName)} disabled={switcher.busy}>
        Ir a este local
      </SmallButton>
      {switcher.error ? <span role="alert">{switcher.error}</span> : null}
      {switcher.dialog}
    </>
  );
}

function ProfileCard({ venue, onSaved }: { venue: VenueDetail; onSaved: (v: VenueDetail) => void }) {
  const [form, setForm] = useState<ProfileForm>(() => profileFormFrom(venue));
  const [pending, setPending] = useState<ProfileChange | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Tras guardar, lo guardado. Guardar otra tarjeta (reglas, IBAN) no borra lo que se está escribiendo aquí.
  useEffect(() => {
    setForm(profileFormFrom(venue));
  }, [venue.name, venue.timezone, venue.vatBps, venue.vatRegime, venue.walletGroup]);

  const set = (key: keyof ProfileForm) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    setSaved(false);
  };

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSaved(false);
    const result = profilePayload(venue, form);
    if (!result.ok) return setError(result.error);
    setError(null);
    if (result.value.needsTotp) return setPending(result.value);
    setSubmitting(true);
    try {
      onSaved(await updateSaVenueProfile(venue.id, result.value.dto));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form className="np-sa-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <SectionHead level={3} title="Perfil" sub="El IVA y el grupo del saldo cambian dinero: te pedirá el código 2FA." />
        <div className="np-sa-grid-2">
          <Input label="Nombre" value={form.name} onChange={set('name')} maxLength={80} disabled={submitting} />
          <Input label="Zona horaria" value={form.timezone} onChange={set('timezone')} disabled={submitting} />
          <Input label="IVA (%)" inputMode="decimal" value={form.vatPct} onChange={set('vatPct')} disabled={submitting} />
          <Select label="Régimen de IVA" value={form.vatRegime} onChange={set('vatRegime')} disabled={submitting}>
            {Object.entries(VAT_REGIME_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <div className="np-sa-span-2">
            <Input
              label="Grupo del saldo"
              value={form.walletGroup}
              onChange={set('walletGroup')}
              placeholder="Ninguno (el saldo solo vale aquí)"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            <Help>
              Los locales con el mismo grupo comparten el saldo de los clientes: lo que se recarga en uno se puede gastar
              en otro. Solo entre locales del mismo dueño.
            </Help>
          </div>
        </div>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        {saved ? (
          <p role="status" className="np-sa-ok">
            Guardado.
          </p>
        ) : null}
        <StickyActions>
          <Button type="submit" loading={submitting}>
            Guardar perfil
          </Button>
        </StickyActions>
      </form>
      {pending ? (
        <StepUpDialog
          title="Cambiar el perfil"
          action="venue.profileMoney"
          summary={`Vas a cambiar en ${venue.name}: ${pending.changes.join('; ')}.`}
          submitLabel="Guardar perfil"
          onSubmit={async ({ totpCode }) => {
            onSaved(await updateSaVenueProfile(venue.id, pending.dto, totpCode));
            setPending(null);
            setSaved(true);
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </Card>
  );
}

function IbanCard({ venue, onSaved }: { venue: VenueDetail; onSaved: (v: VenueDetail) => void }) {
  const [dialog, setDialog] = useState<'set' | 'clear' | null>(null);
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const current = maskedIban(venue.settlementIban) ?? venue.settlementIbanMasked;
  const ibanError = iban.replace(/\s/g, '').length >= 15 ? ibanProblem(iban) : null;

  function openSet(): void {
    setIban('');
    setHolder(venue.settlementHolder ?? '');
    setDialog('set');
  }

  return (
    <Card>
      <div className="np-sa-stack-sm">
        <SectionHead
          level={3}
          title="IBAN del local"
          sub="Donde el banco liquida los cobros con tarjeta. Sirve para cuadrar y para los informes."
        />
        {current ? (
          <MetaList items={[['IBAN', <span key="iban" className="np-sa-mono">{current}</span>], ['Titular', venue.settlementHolder ?? '—']]} />
        ) : (
          <p className="np-sa-text">Este local aún no tiene IBAN.</p>
        )}
        <StickyActions sticky={false}>
          <Button type="button" variant={current ? 'ghost' : 'primary'} onClick={openSet}>
            {current ? 'Cambiar IBAN' : 'Poner IBAN'}
          </Button>
          {current ? (
            <Button type="button" variant="ghost" onClick={() => setDialog('clear')}>
              Quitar IBAN
            </Button>
          ) : null}
        </StickyActions>
      </div>

      {dialog === 'set' ? (
        <StepUpDialog
          title={current ? 'Cambiar el IBAN' : 'Poner el IBAN'}
          action="venue.setIban"
          summary={`Vas a poner el IBAN ${maskedIban(iban) ?? '…'}${holder.trim() ? ` (titular ${holder.trim()})` : ''} en ${venue.name}${current ? `, en lugar de ${current}` : ''}.`}
          validate={() => ibanProblem(iban) ?? holderProblem(holder)}
          submitLabel="Guardar IBAN"
          onSubmit={async ({ totpCode }) => {
            onSaved(await setSaSettlementAccount(venue.id, { iban: iban.replace(/\s/g, ''), holder: holder.trim(), totpCode }));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        >
          <Input
            label="IBAN"
            value={iban}
            onChange={(e) => setIban(formatIbanInput(e.target.value))}
            placeholder="ES91 2100 0418 4502 0005 1332"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            error={ibanError ?? undefined}
            hint="Se comprueba el dígito de control antes de pedirte el código."
          />
          <Input
            label="Titular"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
            placeholder="Razón social del local"
            maxLength={160}
          />
        </StepUpDialog>
      ) : null}

      {dialog === 'clear' ? (
        <StepUpDialog
          title="Quitar el IBAN"
          action="venue.clearIban"
          summary={`Vas a quitar el IBAN ${current ?? ''} de ${venue.name}. Los cobros con tarjeta no se podrán cuadrar con su cuenta hasta que pongas otro.`}
          submitLabel="Quitar IBAN"
          danger
          onSubmit={async ({ totpCode, reason }) => {
            onSaved(await clearSaSettlementAccount(venue.id, { totpCode, reason }));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Card>
  );
}
