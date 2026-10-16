'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input, Modal, Select } from '@nightpay/ui';
import {
  bulkCreateTerminals,
  createPairingCode,
  createTerminal,
  fetchTerminals,
  unpairTerminal,
  updateTerminal,
  type Terminal,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';

interface Props {
  isOwner: boolean;
}

type Zone = 'BARRA' | 'HABITACIONES' | 'MESAS' | 'OTRO';
type Hardware =
  | 'PAX_A920_PRO'
  | 'INGENICO_IM30'
  | 'INGENICO_LANE_3000'
  | 'SUMUP_AIR'
  | 'REDSYS_VX520'
  | 'OTRO';

const HARDWARE_LABEL: Record<Hardware, string> = {
  PAX_A920_PRO: 'PAX A920 Pro',
  INGENICO_IM30: 'Ingenico IM30',
  INGENICO_LANE_3000: 'Ingenico Lane 3000',
  SUMUP_AIR: 'SumUp Air',
  REDSYS_VX520: 'Redsys VX520',
  OTRO: 'Otro',
};

const ZONE_LABEL: Record<Zone, string> = {
  BARRA: 'Barra',
  HABITACIONES: 'Habitaciones',
  MESAS: 'Mesas',
  OTRO: 'Otro',
};

/** El API guarda el modelo como texto: el nombre bonito si es uno conocido. */
function hardwareLabel(model: string | null): string {
  if (!model) return '—';
  return HARDWARE_LABEL[model as Hardware] ?? model;
}

/** Tope de POST /v1/terminals/bulk. */
const BULK_MAX = 50;

export function TerminalsPanel({ isOwner }: Props) {
  const tz = useVenueTimezone();
  /** null = cargando. */
  const [terminals, setTerminals] = useState<Terminal[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<Terminal | null>(null);
  const [pairing, setPairing] = useState<Terminal | null>(null);

  // Create form state
  const [externalId, setExternalId] = useState('');
  const [label, setLabel] = useState('');
  const [zone, setZone] = useState<Zone | ''>('');
  const [zoneCustom, setZoneCustom] = useState('');
  const [hardwareModel, setHardwareModel] = useState<Hardware>('PAX_A920_PRO');
  const [deviceSerial, setDeviceSerial] = useState('');

  async function reload(): Promise<void> {
    setLoadError(null);
    try {
      setTerminals(await fetchTerminals());
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!externalId.trim() || !label.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createTerminal({
        externalId: externalId.trim(),
        label: label.trim(),
        zone: zone || undefined,
        zoneCustom: zone === 'OTRO' ? zoneCustom.trim() : undefined,
        hardwareModel,
        deviceSerial: deviceSerial.trim() || undefined,
      });
      setExternalId('');
      setLabel('');
      setZone('');
      setZoneCustom('');
      setDeviceSerial('');
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {loadError ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => void reload() }}>
          No se pudieron cargar los datáfonos: {loadError}
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Datáfonos / Terminales</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--np-text-mute)' }}>
              Red de PAX A920 Pro por zona. La chica elige zona al cobrar; el camarero de esa zona lo confirma.
            </p>
          </div>
          <Button variant="ghost" size="md" onClick={() => setBulkOpen(true)}>
            + Crear lote
          </Button>
        </div>

        <form onSubmit={handleCreate} style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Input
            label="ExternalId"
            placeholder="PAX-BARRA-1"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            required
          />
          <Input
            label="Label"
            placeholder="PAX Barra 1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
          <Select
            label="Zona"
            value={zone}
            onChange={(e) => setZone(e.target.value as Zone | '')}
          >
            <option value="">— sin zona —</option>
            <option value="BARRA">Barra</option>
            <option value="HABITACIONES">Habitaciones</option>
            <option value="MESAS">Mesas</option>
            <option value="OTRO">Otro…</option>
          </Select>
          {zone === 'OTRO' ? (
            <Input
              label="Nombre zona"
              placeholder="ej: terraza"
              value={zoneCustom}
              onChange={(e) => setZoneCustom(e.target.value)}
              required
            />
          ) : null}
          <Select
            label="Hardware"
            value={hardwareModel}
            onChange={(e) => setHardwareModel(e.target.value as Hardware)}
          >
            {(Object.keys(HARDWARE_LABEL) as Hardware[]).map((h) => (
              <option key={h} value={h}>{HARDWARE_LABEL[h]}</option>
            ))}
          </Select>
          <Input
            label="S/N (opcional)"
            placeholder="número de serie físico"
            value={deviceSerial}
            onChange={(e) => setDeviceSerial(e.target.value)}
          />
          <div style={{ alignSelf: 'end' }}>
            <Button type="submit" loading={creating} size="md">
              Añadir
            </Button>
          </div>
        </form>
      </Card>

      <Card className="np-table-host" style={{ padding: '1.25rem' }}>
        {terminals === null ? (
          <p style={{ margin: 0, fontSize: '0.875rem' }}>{loadError ? 'Sin datos.' : 'Cargando…'}</p>
        ) : terminals.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
            No hay terminales todavía. Crea uno arriba o usa "Crear lote".
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>ExternalId</th>
                <th>Label</th>
                <th>Zona</th>
                <th>Hardware</th>
                <th>S/N</th>
                <th>Estado</th>
                <th>App OxioPay</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {terminals.map((t) => (
                <tr key={t.id}>
                  <td data-label="ExternalId" data-card="top">
                    {t.externalId}
                  </td>
                  <td data-label="Label" data-card="title">
                    {t.label}
                  </td>
                  <td data-label="Zona">{t.zoneDisplay ?? '—'}</td>
                  <td data-label="Hardware">{hardwareLabel(t.hardwareModel)}</td>
                  <td data-label="S/N">{t.deviceSerial ?? '—'}</td>
                  <td data-label="Estado">
                    <span
                      style={{
                        fontSize: '0.75rem',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '999px',
                        background: t.active ? 'var(--np-pill-success-bg)' : 'var(--np-pill-mute-bg)',
                        color: t.active ? 'var(--np-success)' : 'var(--np-text-mute)',
                      }}
                    >
                      {t.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td data-label="App OxioPay">
                    {t.devicePaired ? (
                      <span>
                        Vinculada
                        {t.deviceLastSeenAt ? (
                          <span style={{ color: 'var(--np-text-mute)' }}>
                            {' '}
                            · vista {formatDateTime(t.deviceLastSeenAt, tz, 'compact')}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--np-text-mute)' }}>Sin vincular</span>
                    )}
                  </td>
                  <td data-label="Acciones" data-card="actions">
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <Button variant="ghost" size="md" onClick={() => setEditing(t)}>
                        Editar
                      </Button>
                      {isOwner ? (
                        <Button variant="ghost" size="md" onClick={() => setPairing(t)}>
                          {t.devicePaired ? 'App…' : 'Vincular app'}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <PairingModal
        terminal={pairing}
        onClose={() => {
          setPairing(null);
          reload();
        }}
      />

      <BulkCreateModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onCreated={() => {
          setBulkOpen(false);
          reload();
        }}
      />

      {editing ? (
        <EditTerminalModal
          terminal={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function BulkCreateModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element | null {
  // Texto tal cual (antes, al borrar el campo saltaba a 1).
  const [count, setCount] = useState('6');
  const [prefix, setPrefix] = useState('PAX-BARRA-');
  const [zone, setZone] = useState<Zone>('BARRA');
  const [zoneCustom, setZoneCustom] = useState('');
  const [hardware, setHardware] = useState<Hardware>('PAX_A920_PRO');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const parsedCount = /^\d{1,2}$/.test(count) ? Number(count) : Number.NaN;
  const countOk = Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= BULK_MAX;

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!countOk) {
      setError(`Cantidad: de 1 a ${BULK_MAX}.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await bulkCreateTerminals({
        count: parsedCount,
        prefix: prefix.trim(),
        zone,
        zoneCustom: zone === 'OTRO' ? zoneCustom.trim() : undefined,
        hardwareModel: hardware,
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Crear lote de terminales">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Input
          label="Cantidad"
          type="text"
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 2))}
          error={count !== '' && !countOk ? `De 1 a ${BULK_MAX}.` : undefined}
          required
        />
        <Input
          label="Prefijo del externalId"
          placeholder="PAX-BARRA-"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          required
        />
        <Select label="Zona" value={zone} onChange={(e) => setZone(e.target.value as Zone)}>
          <option value="BARRA">Barra</option>
          <option value="HABITACIONES">Habitaciones</option>
          <option value="MESAS">Mesas</option>
          <option value="OTRO">Otro…</option>
        </Select>
        {zone === 'OTRO' ? (
          <Input
            label="Nombre zona"
            placeholder="ej: terraza"
            value={zoneCustom}
            onChange={(e) => setZoneCustom(e.target.value)}
            required
          />
        ) : null}
        <Select
          label="Hardware"
          value={hardware}
          onChange={(e) => setHardware(e.target.value as Hardware)}
        >
          {(Object.keys(HARDWARE_LABEL) as Hardware[]).map((h) => (
            <option key={h} value={h}>{HARDWARE_LABEL[h]}</option>
          ))}
        </Select>
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', fontSize: '0.85rem' }}>
            {error}
          </p>
        ) : null}
        <p style={{ fontSize: '0.8rem', color: 'var(--np-text-mute)' }}>
          Crea {countOk ? parsedCount : '?'} terminales con externalId {prefix}1, {prefix}2,… asignados a zona{' '}
          <strong>{zone === 'OTRO' ? zoneCustom || '?' : ZONE_LABEL[zone]}</strong>.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} disabled={!countOk}>
            Crear {countOk ? parsedCount : ''}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditTerminalModal({
  terminal,
  onClose,
  onSaved,
}: {
  terminal: Terminal;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  // Detectar zona inicial — si canonical zone es OTRO/<x>, mostrar OTRO + custom
  const initialZoneIsOther = terminal.zone?.startsWith('OTRO/');
  const [label, setLabel] = useState(terminal.label);
  const [zone, setZone] = useState<Zone | ''>(
    initialZoneIsOther ? 'OTRO' : ((terminal.zone as Zone | null) ?? ''),
  );
  const [zoneCustom, setZoneCustom] = useState(
    initialZoneIsOther ? terminal.zone!.slice('OTRO/'.length) : '',
  );
  const [active, setActive] = useState(terminal.active);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateTerminal(terminal.id, {
        label,
        zone: zone || null,
        zoneCustom: zone === 'OTRO' ? zoneCustom.trim() : null,
        active,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Editar ${terminal.externalId}`}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <Select label="Zona" value={zone} onChange={(e) => setZone(e.target.value as Zone | '')}>
          <option value="">— sin zona —</option>
          <option value="BARRA">Barra</option>
          <option value="HABITACIONES">Habitaciones</option>
          <option value="MESAS">Mesas</option>
          <option value="OTRO">Otro…</option>
        </Select>
        {zone === 'OTRO' ? (
          <Input
            label="Nombre zona"
            value={zoneCustom}
            onChange={(e) => setZoneCustom(e.target.value)}
            required
          />
        ) : null}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Activo</span>
        </label>
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', fontSize: '0.85rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting}>
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Vincular la app OxioPay del datáfono: código de un solo uso que se teclea
 * en el datáfono. Con la app vinculada, el cobro llega al lector y vuelve
 * pagado sin teclear el código del ticket.
 */
function PairingModal({ terminal, onClose }: { terminal: Terminal | null; onClose: () => void }) {
  const tz = useVenueTimezone();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCode(null);
    setError(null);
  }, [terminal]);

  if (!terminal) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  const current = terminal;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setCode(await createPairingCode(current.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unpair() {
    if (!window.confirm('¿Desvincular la app de este datáfono? No recibirá cobros hasta que lo vuelvas a vincular.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unpairTerminal(current.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`App OxioPay · ${current.label}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
          <li>Abre la app OxioPay en este datáfono.</li>
          <li>Genera el código y tecléalo en el datáfono (vale 15 minutos y una sola vez).</li>
          <li>Desde entonces el datáfono ve los cobros de las chicas y los cobra sin teclear el ticket.</li>
        </ol>
        {code ? (
          <div style={{ textAlign: 'center', border: '2px solid var(--np-accent)', borderRadius: 'var(--np-r-lg)', padding: '1rem' }}>
            <p className="np-num" style={{ margin: 0, fontSize: '2.25rem', fontWeight: 700, letterSpacing: '0.12em' }}>
              {code.code}
            </p>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.875rem' }}>
              Caduca a las {formatDateTime(code.expiresAt, tz, 'time')}
            </p>
          </div>
        ) : null}
        {error ? <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button loading={busy} onClick={() => void generate()}>
            {code ? 'Generar otro código' : current.devicePaired ? 'Volver a vincular' : 'Generar código'}
          </Button>
          {current.devicePaired ? (
            <Button variant="ghost" loading={busy} onClick={() => void unpair()}>
              Desvincular
            </Button>
          ) : null}
        </div>
        {current.devicePaired ? (
          <p style={{ margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' }}>
            Volver a vincular deja sin acceso al aparato anterior en cuanto se use el código nuevo.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
