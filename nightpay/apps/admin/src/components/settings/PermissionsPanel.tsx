'use client';

import { useState } from 'react';
import { Button, StaffAvatar } from '@nightpay/ui';
import type { PermissionRole, StaffPermissionKey, StaffPermissions, UpdateStaffPermissionsDto } from '@nightpay/contracts';
import { fetchStaffPermissions, updateStaffPermissions, type PermissionPerson } from '@/lib/api';
import { PERMISSION_HINTS, PERMISSION_LABELS, ROLE_LABELS, editablePermissions, hasOverride, personCan, waiterHint } from '@/lib/settings-forms';
import { PuestosCard } from './PuestosCard';
import { LoadState, SettingsCard, StatusLine, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Permisos del personal (dueño): qué deja hacer a los encargados
 * (devolver, dar efectivo, cerrar la noche, pagos a las chicas, informes,
 * recargas en efectivo) y, si hace falta, a una persona en concreto. A los
 * camareros, las recargas en efectivo y devolver el saldo en efectivo a la
 * salida (los de recepción); a los datáfonos de recepción, las recargas.
 * Con el datáfono apagado en Formas de cobro, lo de los datáfonos no sale
 * (lo guardado se queda para cuando vuelva).
 * Por defecto, lo de siempre. El API lo aplica en cada petición.
 */
export function PermissionsPanel({ posOn = true }: { posOn?: boolean } = {}) {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchStaffPermissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  if (!data) return <LoadState error={loadError} retry={retry} what="los permisos" />;
  const { permissions, people } = data;

  async function save(change: UpdateStaffPermissionsDto): Promise<void> {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const next: StaffPermissions = await updateStaffPermissions(change);
      setData({ people: data.people, permissions: next });
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const managers = people.filter((p) => p.role === 'MANAGER');
  const waiters = people.filter((p) => p.role === 'WAITER');

  return (
    <div className="np-set-stack">
      <SettingsCard title="Encargados" tour="permisos-encargados" hint="Lo que pueden hacer todos los encargados. Tú siempre puedes todo.">
        {editablePermissions('MANAGER').map((key) => (
          <Switch
            key={key}
            label={PERMISSION_LABELS[key]}
            checked={permissions.roles.MANAGER[key]}
            disabled={busy}
            onChange={(v) => void save({ roles: { MANAGER: { [key]: v } } })}
          />
        ))}
      </SettingsCard>

      {managers.length + waiters.length > 0 ? (
        <SettingsCard title="Por persona" tour="permisos-persona" hint="Solo si alguien necesita algo distinto a los demás de su rol (p. ej. el camarero de recepción).">
          <ul className="np-set-people">
            {[...managers, ...waiters].map((p) => (
              <PersonRow
                key={p.id}
                person={p}
                permissions={permissions}
                open={openPerson === p.id}
                busy={busy}
                onToggleOpen={() => setOpenPerson(openPerson === p.id ? null : p.id)}
                onChange={(key, v) => void save({ people: { [p.id]: { [key]: v } } })}
                onReset={() => void save({ people: { [p.id]: null } })}
              />
            ))}
          </ul>
        </SettingsCard>
      ) : null}

      <SettingsCard
        title="Camareros" tour="permisos-camareros"
        hint={`${waiterHint(posOn)}${waiters.length > 0 ? ` (${waiters.length} en el local)` : ''}`}
      >
        {editablePermissions('WAITER').map((key) => (
          <Switch
            key={key}
            label={PERMISSION_LABELS[key]}
            hint={PERMISSION_HINTS[key]}
            checked={permissions.roles.WAITER[key]}
            disabled={busy}
            onChange={(v) => void save({ roles: { WAITER: { [key]: v } } })}
          />
        ))}
      </SettingsCard>

      {posOn ? (
        <SettingsCard
          title={ROLE_LABELS.DEVICE}
          hint="El datáfono no sabe quién lo usa: actúa como el local. Si lo enciendes, cualquiera con el datáfono de recepción cobra recargas en efectivo (cuadran en la caja de la noche)."
        >
          {editablePermissions('DEVICE').map((key) => (
            <Switch
              key={key}
              label={PERMISSION_LABELS[key]}
              checked={permissions.roles.DEVICE[key]}
              disabled={busy}
              onChange={(v) => void save({ roles: { DEVICE: { [key]: v } } })}
            />
          ))}
        </SettingsCard>
      ) : null}

      <StatusLine saved={saved} error={error} />

      <PuestosCard />
    </div>
  );
}

function PersonRow({
  person,
  permissions,
  open,
  busy,
  onToggleOpen,
  onChange,
  onReset,
}: {
  person: PermissionPerson;
  permissions: StaffPermissions;
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onChange: (key: StaffPermissionKey, value: boolean) => void;
  onReset: () => void;
}) {
  const role: PermissionRole = person.role;
  const custom = hasOverride(permissions, person);
  const name = person.displayName?.trim() || person.email;
  return (
    <li className="np-set-person" data-open={open || undefined}>
      <div className="np-set-person-head">
        <span className="np-set-person-name" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.625rem' }}>
          <StaffAvatar userId={person.id} hash={person.photoHash ?? null} name={person.displayName?.trim() || null} size={32} />
          {name}
          {custom ? <span className="np-set-tag">A medida</span> : null}
        </span>
        <Button type="button" variant="ghost" onClick={onToggleOpen} aria-expanded={open} className="np-set-small">
          {open ? 'Cerrar' : 'Cambiar'}
        </Button>
      </div>
      {open ? (
        <div className="np-set-person-body">
          {editablePermissions(role).map((key) => (
            <Switch
              key={key}
              label={PERMISSION_LABELS[key]}
              hint={PERMISSION_HINTS[key]}
              checked={personCan(permissions, person, key)}
              disabled={busy}
              onChange={(v) => onChange(key, v)}
            />
          ))}
          {custom ? (
            <Button type="button" variant="ghost" onClick={onReset} disabled={busy} className="np-set-small">
              Volver a lo de los {ROLE_LABELS[role].toLowerCase()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
