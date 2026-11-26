'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import type { OperatorCommissionDefaults, VenueDetail } from '@nightpay/contracts';
import { formatPercent, parsePercentToBps } from '@/lib/commission';
import { updateSaVenueRules } from '@/lib/endpoints/superadmin';
import {
  DEFAULT_REFUND_THRESHOLD_TEXT,
  generalHoldDaysOf,
  rulesFormFrom,
  rulesPayload,
  serviceFeeExample,
  serviceFeeWarning,
  type RulesChange,
  type RulesForm,
} from '@/lib/superadmin/forms';
import { CATEGORY_KEYS, CATEGORY_LABELS, holdDaysText } from '@/lib/superadmin/labels';
import { StepUpDialog } from './StepUpDialog';
import { CheckRow, ErrorLine, Help, SectionHead, StickyActions } from './ui';

interface Props {
  venue: VenueDetail;
  onSaved: (v: VenueDetail) => void;
}

/**
 * Reglas de cobro del local (siempre con 2FA). Cada regla lleva su
 * explicación en llano; solo se manda lo que cambia.
 */
export function VenueRulesCard({ venue, onSaved }: Props) {
  const rules = venue.rules;
  const [form, setForm] = useState<RulesForm>(() => rulesFormFrom(rules));
  const [pending, setPending] = useState<RulesChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const general = generalHoldDaysOf(rules);

  // Tras guardar, lo guardado; guardar otra tarjeta (perfil, IBAN) no borra lo que se está escribiendo.
  useEffect(() => {
    setForm(rulesFormFrom(rules));
  }, [JSON.stringify(rules)]);

  function update(next: Partial<RulesForm>): void {
    setForm((prev) => ({ ...prev, ...next }));
    setSaved(false);
  }

  function setCategory(key: keyof OperatorCommissionDefaults, value: string): void {
    setForm((prev) => ({ ...prev, categories: { ...prev.categories, [key]: value } }));
    setSaved(false);
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    setSaved(false);
    const result = rulesPayload(rules, form, general);
    if (!result.ok) return setError(result.error);
    setError(null);
    setPending(result.value);
  }

  const platformBps = parsePercentToBps(form.platformPct);
  const holdTyped = /^\d{1,2}$/.test(form.holdDays.trim()) ? Number(form.holdDays.trim()) : null;

  return (
    <Card>
      <form className="np-sa-form" onSubmit={handleSubmit} noValidate>
        <SectionHead level={3} title="Reglas" sub="Cambiarlas pide tu código 2FA. Queda en el registro." />

        <div className="np-sa-rule">
          <Input
            label="Tope por cobro con «Otro importe» (€)"
            inputMode="decimal"
            value={form.maxCobroEur}
            onChange={(e) => update({ maxCobroEur: e.target.value })}
          />
          <Help>Lo máximo que una compañera, un camarero o un encargado puede cobrar de una vez con «Otro importe». El dueño no tiene tope. Hasta 10.000 €.</Help>
        </div>

        <div className="np-sa-rule">
          <Input
            label="Comisión de la plataforma (%)"
            inputMode="decimal"
            value={form.platformPct}
            onChange={(e) => update({ platformPct: e.target.value })}
          />
          <Help>
            Lo que se queda OxioPay de cada cobro.
            {form.serviceFeeEnabled ? ' Con la comisión del servicio encendida, el local ya no la paga en los cobros nuevos.' : ''}
          </Help>
        </div>

        <fieldset className="np-sa-rule np-sa-fieldset">
          <legend className="np-sa-label">Comisión del servicio al cliente</legend>
          <CheckRow
            checked={form.serviceFeeEnabled}
            onChange={(on) => update({ serviceFeeEnabled: on })}
            label="Encendida"
            help="La paga el cliente encima del precio y es de OxioPay. Encendida, el local deja de pagar la comisión de la plataforma en lo pagado con ella. Apagada, todo como hasta ahora."
            disabled={!rules.serviceFeeEnabled && Boolean(rules.serviceFeeBlockedReason)}
          />
          {!rules.serviceFeeEnabled && rules.serviceFeeBlockedReason ? (
            <p className="np-sa-callout" role="note">
              {rules.serviceFeeBlockedReason}
            </p>
          ) : null}
          {serviceFeeWarning(form) ? (
            <p className="np-sa-callout" role="status">
              {serviceFeeWarning(form)}
            </p>
          ) : null}
          <div className="np-sa-grid-2">
            <Input
              label="En los pagos con tarjeta (%)"
              inputMode="decimal"
              value={form.serviceFeePct}
              onChange={(e) => update({ serviceFeePct: e.target.value })}
              hint={serviceFeeExample(form.serviceFeePct, 'card') ?? 'De 0 a 12 %.'}
            />
            <Input
              label="En las recargas del saldo (%)"
              inputMode="decimal"
              value={form.topUpServiceFeePct}
              onChange={(e) => update({ topUpServiceFeePct: e.target.value })}
              hint={serviceFeeExample(form.topUpServiceFeePct, 'topUp') ?? 'De 0 a 12 %.'}
            />
          </div>
          <Help>
            Con tarjeta, Apple Pay, Google Pay o el datáfono, y en las recargas (tarjeta o efectivo). Gastar del saldo no
            la lleva y la propina tampoco. El saldo cargado antes de encenderla sigue pagando la comisión de la
            plataforma al gastarse; el cargado con ella, no. Los cobros ya creados no cambian.
          </Help>
        </fieldset>

        <fieldset className="np-sa-rule np-sa-fieldset">
          <legend className="np-sa-label">Cobro del servicio</legend>
          <CheckRow
            checked={form.operatorsChargeFromPhone}
            onChange={(on) => update({ operatorsChargeFromPhone: on })}
            label="Las compañeras cobran desde su móvil"
            help="Apagada, no cobran desde su app: cobra el encargado (o recepción, si se lo dan en Permisos) escaneando su «Mi QR», y el dinero del servicio le llega a ella con su % y la propina entera. Los locales nuevos empiezan apagados. Apágala cuando el personal tenga la app nueva."
          />
        </fieldset>

        <fieldset className="np-sa-rule np-sa-fieldset">
          <legend className="np-sa-label">Comisiones por categoría (%)</legend>
          <Help>
            Lo que se lleva quien hace el cobro (la compañera o el camarero) según lo que cobra. Con la comisión de la
            plataforma no puede pasar del 100 %: el resto es del local.
          </Help>
          <div className="np-sa-grid-2">
            {CATEGORY_KEYS.map((key) => {
              const bps = parsePercentToBps(form.categories[key]);
              const venueShare = bps !== null && platformBps !== null ? 10_000 - bps - platformBps : null;
              return (
                <Input
                  key={key}
                  label={CATEGORY_LABELS[key]}
                  inputMode="decimal"
                  value={form.categories[key]}
                  onChange={(e) => setCategory(key, e.target.value)}
                  error={venueShare !== null && venueShare < 0 ? 'Con la plataforma pasa del 100 %.' : undefined}
                  hint={venueShare !== null && venueShare >= 0 ? `El local se queda ${formatPercent(venueShare)}.` : undefined}
                />
              );
            })}
          </div>
        </fieldset>

        <div className="np-sa-rule">
          <Input
            label="Días de espera para pagar a las compañeras"
            inputMode="numeric"
            value={form.holdDays}
            onChange={(e) => update({ holdDays: e.target.value.replace(/\D/g, '').slice(0, 2) })}
            placeholder={general === null ? 'Lo general' : `Lo general (${general})`}
          />
          <p className="np-sa-callout">
            <strong>0 = se les paga al cerrar la noche.</strong> Vacío = lo general. Hoy se aplica:{' '}
            {holdDaysText(rules.effectivePayoutHoldDays).toLowerCase()}.
            {holdTyped !== null && holdTyped !== rules.effectivePayoutHoldDays
              ? ` Al guardar: ${holdDaysText(holdTyped).toLowerCase()}.`
              : ''}
          </p>
          <Help>Desde que la compañera cobra hasta que se le puede pagar lo suyo (por si hay devoluciones).</Help>
        </div>

        <div className="np-sa-rule">
          <Input
            label="Devolución que necesita aprobación (€)"
            inputMode="decimal"
            value={form.refundThresholdEur}
            onChange={(e) => update({ refundThresholdEur: e.target.value })}
          />
          <Help>
            Las devoluciones de más de este importe las tiene que aprobar el dueño. Por defecto{' '}
            {DEFAULT_REFUND_THRESHOLD_TEXT}; 0 = todas.
          </Help>
        </div>

        <CheckRow
          checked={form.payoutRequiresApproval}
          onChange={(on) => update({ payoutRequiresApproval: on })}
          label="Los pagos a las compañeras necesitan aprobación"
          help="El encargado pide el pago y el dueño lo aprueba con su código. Quien lo pide no lo puede aprobar."
        />

        {error ? <ErrorLine>{error}</ErrorLine> : null}
        {saved ? (
          <p role="status" className="np-sa-ok">
            Reglas guardadas.
          </p>
        ) : null}
        <StickyActions>
          <Button type="button" variant="ghost" onClick={() => setForm(rulesFormFrom(rules))}>
            Deshacer
          </Button>
          <Button type="submit">Guardar reglas</Button>
        </StickyActions>
      </form>

      {pending ? (
        <StepUpDialog
          title="Cambiar las reglas"
          action="venue.rules"
          summary={`Vas a cambiar las reglas de ${venue.name}: ${pending.changes.join('; ')}.`}
          submitLabel="Guardar reglas"
          onSubmit={async ({ totpCode }) => {
            onSaved(await updateSaVenueRules(venue.id, pending.dto, totpCode));
            setPending(null);
            setSaved(true);
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </Card>
  );
}
