'use client';

import { useState } from 'react';
import { Button, Card, Etiqueta, Select, formatDateTime, formatRelative } from '@nightpay/ui';
import type { PartnerFreeze, PartnerView, SuperAdminPartnerConnectionView, SuperAdminPartnersOverview } from '@nightpay/contracts';
import {
  fetchSaPartners,
  pauseSaPartnerConnection,
  resumeSaPartner,
  resumeSaPartnerConnection,
  revokeSaPartnerConnection,
  setSaPartnerFreeze,
  suspendSaPartner,
} from '@/lib/endpoints/superadmin';
import { SCOPE_LABELS, connectionTag } from '@/lib/partner-connections';
import { CHANNEL_LABELS, COLLECTION_TEXT, FREEZE_CHOICES, partnerMissing } from '@/lib/superadmin/partner-forms';
import '../../styles/panel-partners.css';
import { PartnerFormDialog } from './PartnerFormDialog';
import { StepUpDialog, type StepUpValues } from './StepUpDialog';
import { LoadGate, MetaList, SectionHead, SmallButton } from './ui';
import { useLoad } from './use-load';

type Dialog =
  | { kind: 'form'; partner: PartnerView | null }
  | { kind: 'freeze' }
  | { kind: 'partner'; action: 'partner.suspend' | 'partner.resume'; partner: PartnerView }
  | {
      kind: 'connection';
      action: 'partner.connectionPause' | 'partner.connectionResume' | 'partner.connectionRevoke';
      connection: SuperAdminPartnerConnectionView;
    };

const freezeLabel = (f: PartnerFreeze) => FREEZE_CHOICES.find((c) => c.value === f)?.label ?? f;

/**
 * Consola → «Socios» (API de socios): el estado de la API y su congelación,
 * el registro de socios (techo de permisos, IP, KYB y contrato de datos) y las
 * conexiones de todos los locales (solo la pista de la clave). Funciona
 * también con la API apagada. Lo que pide cada acción, en SA_ACTION_RULES.
 */
export function PartnersSection() {
  const list = useLoad((signal) => fetchSaPartners(signal), []);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  function done(): void {
    setDialog(null);
    list.reload();
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="API de socios"
        title="Socios"
        sub="Las plataformas que entran con una clave en el saldo de los locales (la primera, los cajeros). Sin KYB ni contrato de datos, ningún local puede conectarlas."
        actions={<Button onClick={() => setDialog({ kind: 'form', partner: null })}>+ Nuevo socio</Button>}
      />
      <LoadGate loaded={list} what="los socios">
        {(data) => (
          <>
            <ApiStateCard api={data.api} onFreeze={() => setDialog({ kind: 'freeze' })} />
            <PartnersTable partners={data.partners} onOpen={setDialog} />
            <ConnectionsTable connections={data.connections} onOpen={setDialog} />
            {dialog ? <ActiveDialog dialog={dialog} data={data} onClose={() => setDialog(null)} onDone={done} /> : null}
          </>
        )}
      </LoadGate>
    </div>
  );
}

function ApiStateCard({ api, onFreeze }: { api: SuperAdminPartnersOverview['api']; onFreeze: () => void }) {
  return (
    <Card>
      <SectionHead
        level={3}
        title="Estado de la API"
        actions={<SmallButton onClick={onFreeze}>Cambiar la congelación</SmallButton>}
      />
      <MetaList
        items={[
          ['Interruptor', api.enabled ? 'Encendida' : 'Apagada (la enciende el despliegue)'],
          ['Modo', api.mode === 'live' ? 'Real' : api.mode === 'test' ? 'Pruebas' : '—'],
          [
            'Congelación',
            <Etiqueta key="f" tone={api.freeze === 'none' ? 'success' : 'danger'}>
              {freezeLabel(api.freeze)}
            </Etiqueta>,
          ],
          ['Motivo', api.reason ?? '—'],
          ['Desde', formatDateTime(api.updatedAt)],
        ]}
      />
    </Card>
  );
}

function PartnersTable({ partners, onOpen }: { partners: PartnerView[]; onOpen: (d: Dialog) => void }) {
  if (partners.length === 0) return <p className="np-sa-empty">Aún no hay socios.</p>;
  return (
    <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="np-sa-scroll-x">
        <table className="np-table">
          <thead>
            <tr>
              <th>Socio</th>
              <th>NIF / CIF</th>
              <th>Puede</th>
              <th>IP</th>
              <th>Para conectar</th>
              <th>Estado</th>
              <th aria-label="Acciones" />
            </tr>
          </thead>
          <tbody>
            {partners.map((p) => {
              const missing = partnerMissing(p);
              return (
                <tr key={p.id}>
                  <td data-label="Socio" data-card="title">
                    {p.name}
                    <span className="np-ptn-help">
                      {p.legalName} · {CHANNEL_LABELS[p.channel]} · {COLLECTION_TEXT}
                    </span>
                  </td>
                  <td data-label="NIF / CIF" className="np-sa-mono">
                    {p.taxId}
                  </td>
                  <td data-label="Puede">{p.allowedScopes.map((s) => SCOPE_LABELS[s]).join(' · ')}</td>
                  <td data-label="IP" className="np-ptn-mono">
                    {p.egressIps.length > 0 ? p.egressIps.join(', ') : '—'}
                  </td>
                  <td data-label="Para conectar">
                    {missing.length === 0 ? (
                      <Etiqueta tone="success">Lista</Etiqueta>
                    ) : (
                      <span className="np-ptn-help">Le falta {missing.join(', ')}.</span>
                    )}
                  </td>
                  <td data-label="Estado" data-card="status">
                    {p.status === 'SUSPENDED' ? <Etiqueta tone="danger">Suspendida</Etiqueta> : <Etiqueta tone="success">Activa</Etiqueta>}
                  </td>
                  <td data-label="" data-card="actions">
                    <span className="np-ptn-actions">
                      <SmallButton onClick={() => onOpen({ kind: 'form', partner: p })}>Abrir</SmallButton>
                      {p.status === 'SUSPENDED' ? (
                        <SmallButton onClick={() => onOpen({ kind: 'partner', action: 'partner.resume', partner: p })}>Reanudar</SmallButton>
                      ) : (
                        <SmallButton variant="danger" onClick={() => onOpen({ kind: 'partner', action: 'partner.suspend', partner: p })}>
                          Suspender
                        </SmallButton>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ConnectionsTable({ connections, onOpen }: { connections: SuperAdminPartnerConnectionView[]; onOpen: (d: Dialog) => void }) {
  const now = new Date();
  return (
    <>
      <SectionHead level={3} title="Conexiones de los locales" sub="Solo se ve cómo termina cada clave." />
      {connections.length === 0 ? (
        <p className="np-sa-empty">Ningún local ha conectado aún una plataforma.</p>
      ) : (
        <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="np-sa-scroll-x">
            <table className="np-table">
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Socio</th>
                  <th>Estado</th>
                  <th>Clave</th>
                  <th>Caduca</th>
                  <th>Último uso</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => {
                  const tag = connectionTag(c);
                  const open = c.state !== 'revoked';
                  const paused = c.state === 'paused' || c.pausedBy !== null;
                  return (
                    <tr key={c.id}>
                      <td data-label="Local" data-card="title">
                        {c.venueName}
                      </td>
                      <td data-label="Socio">{c.partnerName}</td>
                      <td data-label="Estado" data-card="status">
                        <Etiqueta tone={tag.tone}>{tag.label}</Etiqueta>
                        {c.mode === 'test' ? <Etiqueta tone="info">Prueba</Etiqueta> : null}
                      </td>
                      <td data-label="Clave" className="np-ptn-mono">
                        {c.keyHint}
                      </td>
                      <td data-label="Caduca">{c.keyExpiresAt ? formatDateTime(c.keyExpiresAt, undefined, 'dayMonthYear') : 'Sin caducidad'}</td>
                      <td data-label="Último uso">
                        {c.lastUsedAt ? `${formatRelative(c.lastUsedAt, now)}${c.lastUsedIp ? ` · ${c.lastUsedIp}` : ''}` : 'Aún no'}
                      </td>
                      <td data-label="" data-card="actions">
                        {open ? (
                          <span className="np-ptn-actions">
                            {paused ? (
                              <SmallButton onClick={() => onOpen({ kind: 'connection', action: 'partner.connectionResume', connection: c })}>
                                Reanudar
                              </SmallButton>
                            ) : (
                              <SmallButton onClick={() => onOpen({ kind: 'connection', action: 'partner.connectionPause', connection: c })}>
                                Pausar
                              </SmallButton>
                            )}
                            <SmallButton
                              variant="danger"
                              onClick={() => onOpen({ kind: 'connection', action: 'partner.connectionRevoke', connection: c })}
                            >
                              Anular
                            </SmallButton>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function ActiveDialog({
  dialog,
  data,
  onClose,
  onDone,
}: {
  dialog: Dialog;
  data: SuperAdminPartnersOverview;
  onClose: () => void;
  onDone: () => void;
}) {
  const [freeze, setFreeze] = useState<PartnerFreeze>(data.api.freeze);

  if (dialog.kind === 'form') return <PartnerFormDialog partner={dialog.partner} onClose={onClose} onSaved={onDone} />;

  if (dialog.kind === 'freeze') {
    const choice = FREEZE_CHOICES.find((c) => c.value === freeze)!;
    return (
      <StepUpDialog
        title="Congelación de la API"
        action="partner.freeze"
        summary={`Vas a dejar la API así: ${choice.label}. Vale para todos los locales al momento.`}
        validate={() => (freeze === data.api.freeze ? 'Elige otra posición: ya está así.' : null)}
        submitLabel="Guardar"
        danger={freeze !== 'none'}
        onSubmit={async (v: StepUpValues) => {
          await setSaPartnerFreeze(freeze, v);
          onDone();
        }}
        onClose={onClose}
      >
        <Select label="Cómo queda" value={freeze} onChange={(e) => setFreeze(e.target.value as PartnerFreeze)} hint={choice.hint}>
          {FREEZE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </StepUpDialog>
    );
  }

  if (dialog.kind === 'partner') {
    const p = dialog.partner;
    const suspending = dialog.action === 'partner.suspend';
    return (
      <StepUpDialog
        title={suspending ? `Suspender ${p.name}` : `Reanudar ${p.name}`}
        action={dialog.action}
        summary={
          suspending
            ? `Vas a suspender ${p.name}: ninguna de sus claves funciona y ningún local puede conectarla.`
            : `Vas a reanudar ${p.name}: sus claves vuelven a funcionar.`
        }
        submitLabel={suspending ? 'Suspender' : 'Reanudar'}
        danger={suspending}
        onSubmit={async (v) => {
          await (suspending ? suspendSaPartner(p.id, v) : resumeSaPartner(p.id, v));
          onDone();
        }}
        onClose={onClose}
      />
    );
  }

  const c = dialog.connection;
  const texts = {
    'partner.connectionPause': {
      title: `Pausar ${c.partnerName} en ${c.venueName}`,
      summary: `Vas a pausar la clave de ${c.partnerName} en ${c.venueName}. El local la verá «En pausa por OxioPay» y no podrá reanudarla.`,
      submit: 'Pausar',
    },
    'partner.connectionResume': {
      title: `Reanudar ${c.partnerName} en ${c.venueName}`,
      summary: `Vas a reanudar la clave de ${c.partnerName} en ${c.venueName}.`,
      submit: 'Reanudar',
    },
    'partner.connectionRevoke': {
      title: `Anular ${c.partnerName} en ${c.venueName}`,
      summary: `Vas a anular la clave de ${c.partnerName} en ${c.venueName}: deja de funcionar para siempre.`,
      submit: 'Anular',
    },
  }[dialog.action];
  return (
    <StepUpDialog
      title={texts.title}
      action={dialog.action}
      summary={texts.summary}
      submitLabel={texts.submit}
      danger={dialog.action !== 'partner.connectionResume'}
      onSubmit={async (v) => {
        if (dialog.action === 'partner.connectionPause') await pauseSaPartnerConnection(c.id, v.reason);
        else if (dialog.action === 'partner.connectionResume') await resumeSaPartnerConnection(c.id, v);
        else await revokeSaPartnerConnection(c.id, v);
        onDone();
      }}
      onClose={onClose}
    />
  );
}
