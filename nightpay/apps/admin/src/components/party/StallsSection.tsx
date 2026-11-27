'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { STALL_SELLS_MAX, STALL_ZONE_MAX, type StallStaffPerson, type StallView, type UpdateStallDto } from '@nightpay/contracts';
import { Button, Checkbox, FormError, Input } from '@nightpay/ui';
import { totpRetryState } from '@/lib/api-errors';
import { assignStall, createStall, deleteStall, fetchPartySettings, fetchStallStaff, fetchStalls, updateStall } from '@/lib/endpoints/party';
import { OTP_LENGTH } from '@/lib/otp';
import {
  EMPTY_STALL_FORM,
  STALL_BPS_LOCKED_HINT,
  STALL_BPS_LOCKED_NOTE,
  assignableStalls,
  createStallDto,
  hasStallChange,
  organizerText,
  stallFormFrom,
  stallIbanText,
  staffName,
  staffRoleLabel,
  updateStallDto,
  type StallForm,
} from '@/lib/party-stalls';
import { Notice } from '../Notice';
import { OtpInput } from '../OtpInput';

/** Qué se está editando: una caseta nueva o una que ya existe. */
type Editing = { kind: 'new' } | { kind: 'edit'; stall: StallView } | null;

/**
 * OxioParty · Casetas (maqueta Alta, «2 · Casetas y barras»): dar de alta,
 * cambiar y archivar las casetas, con la parte del organizador (un % o
 * «barra propia») y el IBAN para pagarles, y lo que ven los asistentes en la
 * página de su pulsera (zona, qué vende y «Abierta ahora»); y el personal de
 * cada una (sus cobros llevan esa caseta). La parte del organizador y el IBAN son dinero:
 * con la 2FA activada, guardarlos pide el código. Con la fiesta terminada,
 * el % de las que ya existen queda fijo (el cierre no cambia) y se avisa.
 */
export function StallsSection() {
  const [stalls, setStalls] = useState<StallView[] | null>(null);
  const [staff, setStaff] = useState<StallStaffPerson[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bpsLocked, setBpsLocked] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // La fiesta solo para saber si ya terminó: si no llega, el API igual dice que no (409) al guardar.
      const [s, p, ended] = await Promise.all([
        fetchStalls(),
        fetchStallStaff(),
        fetchPartySettings()
          .then((settings) => settings.eventEnded)
          .catch(() => false),
      ]);
      setStalls(s);
      setStaff(p);
      setBpsLocked(ended);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function saved(stall: StallView, created: boolean): void {
    setStalls((prev) => (prev ? (created ? [...prev, stall] : prev.map((s) => (s.id === stall.id ? stall : s))) : [stall]));
    setEditing(null);
    setNotice(created ? `Caseta «${stall.name}» dada de alta.` : `Caseta «${stall.name}» guardada.`);
  }

  async function toggleActive(stall: StallView): Promise<void> {
    setNotice(null);
    try {
      saved(await updateStall(stall.id, { active: !stall.active }), false);
      // Al archivarla, su personal se queda sin poder cobrar con ella: se recarga la lista.
      if (stall.active) setStaff(await fetchStallStaff());
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  async function remove(stall: StallView): Promise<void> {
    setNotice(null);
    try {
      const r = await deleteStall(stall.id);
      setStalls((prev) => prev?.filter((s) => s.id !== stall.id) ?? null);
      setStaff((prev) => prev?.map((p) => (p.stallId === stall.id ? { ...p, stallId: null } : p)) ?? null);
      setNotice(`Caseta «${stall.name}» borrada${r.unassignedStaff > 0 ? `; ${r.unassignedStaff} personas se han quedado sin caseta` : ''}.`);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  async function assign(person: StallStaffPerson, stallId: string | null): Promise<void> {
    setNotice(null);
    try {
      const updated = await assignStall(person.id, { stallId });
      setStaff((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? null);
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  if (loadError) {
    return (
      <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => void load() }}>
        No se pudieron cargar las casetas: {loadError}
      </Notice>
    );
  }

  return (
    <StallsView
      stalls={stalls}
      staff={staff}
      editing={editing}
      notice={notice}
      bpsLocked={bpsLocked}
      onNew={() => setEditing({ kind: 'new' })}
      onEdit={(stall) => setEditing({ kind: 'edit', stall })}
      onCancel={() => setEditing(null)}
      onSaved={saved}
      onToggleActive={(s) => void toggleActive(s)}
      onRemove={(s) => void remove(s)}
      onAssign={(p, id) => void assign(p, id)}
    />
  );
}

export interface StallsViewProps {
  stalls: StallView[] | null;
  staff: StallStaffPerson[] | null;
  editing: Editing;
  notice: string | null;
  /** La fiesta ya terminó: el % de cada caseta ya no se cambia (409 STALL_BPS_LOCKED). */
  bpsLocked?: boolean;
  onNew: () => void;
  onEdit: (s: StallView) => void;
  onCancel: () => void;
  onSaved: (s: StallView, created: boolean) => void;
  onToggleActive: (s: StallView) => void;
  onRemove: (s: StallView) => void;
  onAssign: (p: StallStaffPerson, stallId: string | null) => void;
}

export function StallsView(p: StallsViewProps) {
  return (
    <div className="np-party">
      <div className="np-party-head">
        <div className="np-party-head-text">
          <h2 className="np-party-title">Casetas y barras</h2>
          <p className="np-party-sub">Tú fijas el % que se queda la organización en cada una. Las de «barra propia» no se pagan.</p>
        </div>
        {p.editing?.kind !== 'new' ? <Button onClick={p.onNew}>Añadir caseta</Button> : null}
      </div>

      {p.bpsLocked ? <Notice tone="warning">{STALL_BPS_LOCKED_NOTE}</Notice> : null}
      {p.notice ? <Notice tone="info">{p.notice}</Notice> : null}
      {p.editing ? (
        <StallFormCard
          key={p.editing.kind === 'edit' ? p.editing.stall.id : 'new'}
          editing={p.editing}
          bpsLocked={p.bpsLocked ?? false}
          onCancel={p.onCancel}
          onSaved={p.onSaved}
        />
      ) : null}

      <section className="np-party-card" aria-labelledby="np-party-h-list">
        <h3 id="np-party-h-list" className="np-party-card-title">
          Las casetas
        </h3>
        {p.stalls === null ? (
          <p className="np-party-empty">Cargando…</p>
        ) : p.stalls.length === 0 ? (
          <p className="np-party-empty">Aún no hay casetas. Añade la primera con su responsable, su % y su IBAN.</p>
        ) : (
          <div className="np-party-scroll">
            <table className="np-party-table" style={{ minWidth: '46rem' }}>
              <thead>
                <tr>
                  <th scope="col">Caseta</th>
                  <th scope="col" data-num="true">
                    % organización
                  </th>
                  <th scope="col">IBAN para pagarle</th>
                  <th scope="col" data-num="true">
                    Personal
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col">
                    <span className="np-sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.stalls.map((s) => (
                  <StallRow key={s.id} stall={s} onEdit={p.onEdit} onToggleActive={p.onToggleActive} onRemove={p.onRemove} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <StaffCard stalls={p.stalls ?? []} staff={p.staff} onAssign={p.onAssign} />
    </div>
  );
}

function StallRow({
  stall,
  onEdit,
  onToggleActive,
  onRemove,
}: {
  stall: StallView;
  onEdit: (s: StallView) => void;
  onToggleActive: (s: StallView) => void;
  onRemove: (s: StallView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const iban = stallIbanText(stall);
  const where = [stall.zone, stall.sells].filter(Boolean).join(' · ');
  return (
    <tr>
      <th scope="row">
        <span className="np-party-strong">{stall.name}</span>
        <span className="np-party-dim">
          {stall.managerName}
          {stall.managerContact ? ` · ${stall.managerContact}` : ''}
        </span>
        {where ? <span className="np-party-dim">{where}</span> : null}
      </th>
      <td data-num="true">
        <span className="np-party-chip">{organizerText(stall.organizerBps)}</span>
      </td>
      <td>
        <span className="np-party-status" data-tone={iban.tone}>
          {iban.text}
        </span>
      </td>
      <td data-num="true" className="np-party-num">
        {stall.staffCount}
      </td>
      <td>
        <span className="np-party-status" data-tone={stall.active ? 'success' : 'neutral'}>
          {stall.active ? 'Activa' : 'Archivada'}
        </span>
        {stall.active ? <span className="np-party-dim">{stall.openNow ? 'Abierta ahora' : 'Cerrada ahora'}</span> : null}
      </td>
      <td>
        <div className="np-party-actions">
          {confirming ? (
            <>
              <span className="np-party-card-note">¿Borrarla?</span>
              <Button size="sm" variant="danger" onClick={() => onRemove(stall)}>
                Sí, borrar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                No
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => onEdit(stall)}>
                Editar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onToggleActive(stall)}>
                {stall.active ? 'Archivar' : 'Reactivar'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Borrar ${stall.name}`}>
                Borrar
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function StallFormCard({
  editing,
  bpsLocked,
  onCancel,
  onSaved,
}: {
  editing: NonNullable<Editing>;
  bpsLocked: boolean;
  onCancel: () => void;
  onSaved: (s: StallView, created: boolean) => void;
}) {
  const current = editing.kind === 'edit' ? editing.stall : null;
  // Fiesta terminada: el % de una que ya existe no se toca (una nueva no tiene ventas: sí).
  const bpsFixed = bpsLocked && current !== null;
  const [form, setForm] = useState<StallForm>(current ? stallFormFrom(current) : EMPTY_STALL_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askCode, setAskCode] = useState(false);
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  function update(patch: Partial<StallForm>): void {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (askCode && code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
    const totp = askCode ? { totpCode: code } : {};
    setBusy(true);
    setError(null);
    try {
      if (current) {
        const plan = updateStallDto(form, current);
        if (!plan.ok) return setError(plan.problem);
        if (!hasStallChange(plan.value)) return onCancel();
        const dto: UpdateStallDto = { ...plan.value, ...totp };
        onSaved(await updateStall(current.id, dto), false);
      } else {
        const plan = createStallDto(form);
        if (!plan.ok) return setError(plan.problem);
        onSaved(await createStall({ ...plan.value, ...totp }), true);
      }
    } catch (err) {
      const retry = totpRetryState(err, Date.now());
      setLockedUntil(retry.lockedUntil);
      setCode('');
      if (retry.askCode) setAskCode(true);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="np-party-card" onSubmit={(e) => void onSubmit(e)} noValidate aria-labelledby="np-party-h-form">
      <h3 id="np-party-h-form" className="np-party-card-title">
        {current ? `Cambiar «${current.name}»` : 'Nueva caseta'}
      </h3>
      <div className="np-party-form">
        <Input label="Caseta" value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="Peña El Cántaro" maxLength={80} />
        <Input
          label="Responsable"
          value={form.managerName}
          onChange={(e) => update({ managerName: e.target.value })}
          placeholder="Nombre de quien la lleva"
          maxLength={120}
        />
        <Input
          label="Contacto (opcional)"
          value={form.managerContact}
          onChange={(e) => update({ managerContact: e.target.value })}
          hint="Su teléfono: el aviso de «sin cobros» te deja llamarle."
          inputMode="tel"
          maxLength={160}
        />
        <Input
          label="Zona (opcional)"
          value={form.zone}
          onChange={(e) => update({ zone: e.target.value })}
          placeholder="Junto al escenario"
          hint="Los asistentes ven la lista de casetas en la página de su pulsera."
          maxLength={STALL_ZONE_MAX}
        />
        <Input
          label="Qué vende (opcional)"
          value={form.sells}
          onChange={(e) => update({ sells: e.target.value })}
          placeholder="Bocadillos, cerveza, refrescos"
          maxLength={STALL_SELLS_MAX}
        />
        <div>
          <Input
            label="% para la organización"
            value={form.ownBar ? '100' : form.percent}
            onChange={(e) => update({ percent: e.target.value })}
            placeholder="10"
            inputMode="decimal"
            disabled={form.ownBar || bpsFixed}
            hint={bpsFixed ? STALL_BPS_LOCKED_HINT : 'De lo que venda, lo que se queda la organización.'}
          />
          <Checkbox
            label="Barra propia (todo para la organización; no se le paga)"
            checked={form.ownBar}
            disabled={bpsFixed}
            onChange={(ownBar) => update({ ownBar })}
          />
        </div>
        <div className="np-party-form-wide">
          <Input
            label="IBAN para pagarle"
            value={form.iban}
            onChange={(e) => update({ iban: e.target.value })}
            placeholder="ES00 0000 0000 0000 0000 0000"
            autoComplete="off"
            spellCheck={false}
            hint={form.ownBar ? 'Una barra propia no se paga: no hace falta.' : 'Sin IBAN se cuenta, pero no va en el fichero del banco.'}
          />
        </div>
        <Checkbox
          label="Abierta ahora (lo ven los asistentes; su personal también lo cambia desde su app)"
          checked={form.openNow}
          onChange={(openNow) => update({ openNow })}
        />
        {current ? <Checkbox label="Activa (se le puede dar personal y cobrar)" checked={form.active} onChange={(active) => update({ active })} /> : null}
      </div>
      {askCode ? (
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={code}
          onChange={setCode}
          autoSubmit
          autoFocus
          lockedUntil={lockedUntil}
          disabled={busy}
          hint="La parte de la organización y el IBAN son dinero: al poner el sexto número se guarda."
        />
      ) : null}
      {error ? (
        <FormError>
          {error}
        </FormError>
      ) : null}
      <div className="np-party-actions">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button type="submit" loading={busy}>
          {askCode ? 'Confirmar y guardar' : current ? 'Guardar' : 'Dar de alta'}
        </Button>
      </div>
    </form>
  );
}

function StaffCard({
  stalls,
  staff,
  onAssign,
}: {
  stalls: readonly StallView[];
  staff: StallStaffPerson[] | null;
  onAssign: (p: StallStaffPerson, stallId: string | null) => void;
}) {
  const options = assignableStalls(stalls);
  return (
    <section className="np-party-card" aria-labelledby="np-party-h-staff">
      <div className="np-party-card-head">
        <h3 id="np-party-h-staff" className="np-party-card-title">
          El personal de cada caseta
        </h3>
        <span className="np-party-card-note">Lo que cobra cada persona va a su caseta.</span>
      </div>
      {staff === null ? (
        <p className="np-party-empty">Cargando…</p>
      ) : staff.length === 0 ? (
        <p className="np-party-empty">Aún no hay personal: dalo de alta y aquí le eliges su caseta.</p>
      ) : (
        <div className="np-party-scroll">
          <table className="np-party-table" style={{ minWidth: '32rem' }}>
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Puesto</th>
                <th scope="col">Caseta</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((person) => {
                const name = staffName(person);
                const archived = person.stallId && !options.some((s) => s.id === person.stallId);
                return (
                  <tr key={person.id}>
                    <th scope="row">
                      <span className="np-party-strong">{name}</span>
                      {person.displayName ? <span className="np-party-dim">{person.email}</span> : null}
                    </th>
                    <td>{staffRoleLabel(person.role)}</td>
                    <td>
                      <select
                        className="np-party-select"
                        aria-label={`Caseta de ${name}`}
                        value={person.stallId ?? ''}
                        onChange={(e) => onAssign(person, e.target.value || null)}
                      >
                        <option value="">Sin caseta</option>
                        {archived ? (
                          <option value={person.stallId ?? ''} disabled>
                            {stalls.find((s) => s.id === person.stallId)?.name ?? 'Archivada'} (archivada)
                          </option>
                        ) : null}
                        {options.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
