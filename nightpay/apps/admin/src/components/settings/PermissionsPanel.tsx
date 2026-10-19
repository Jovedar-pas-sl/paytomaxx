'use client';

import { useState } from 'react';
import { Button } from '@nightpay/ui';
import type { PermissionRole, StaffPermissionKey, StaffPermissions, UpdateStaffPermissionsDto } from '@nightpay/contracts';
import { fetchStaffPermissions, updateStaffPermissions, type PermissionPerson } from '@/lib/api';
import { PERMISSION_LABELS, editablePermissions, hasOverride, personCan } from '@/lib/settings-forms';
import { LoadState, SettingsCard, StatusLine, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Permisos del personal (dueño): qué deja hacer a los encargados
 * (devolver, dar efectivo, cerrar la noche, pagos a las chicas, informes) y,
 * si hace falta, a una persona en concreto. Por defecto, lo de siempre. El
 * API lo aplica en cada petición.
 */
export function PermissionsPanel() {
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
      <SettingsCard title="Encargados" hint="Lo que pueden hacer todos los encargados. Tú siempre puedes todo.">
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

      {managers.length > 0 ? (
        <SettingsCard title="Por persona" hint="Solo si alguien necesita algo distinto a los demás encargados.">
          <ul className="np-set-people">
            {managers.map((p) => (
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
        title="Camareros"
        hint={`Cobran y confirman datáfonos desde su app; ninguna de estas acciones les llega.${
          waiters.length > 0 ? ` (${waiters.length} en el local)` : ''
        }`}
      >
        {null}
      </SettingsCard>

      <StatusLine saved={saved} error={error} />
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
        <span className="np-set-person-name">
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
              checked={personCan(permissions, person, key)}
              disabled={busy}
              onChange={(v) => onChange(key, v)}
            />
          ))}
          {custom ? (
            <Button type="button" variant="ghost" onClick={onReset} disabled={busy} className="np-set-small">
              Volver a lo de los encargados
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
