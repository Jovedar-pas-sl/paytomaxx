// Registro (audit_events): el nombre de máquina de cada acción → castellano
// llano. Lo que hace la consola lleva el prefijo "superadmin."; se quita para
// buscar el nombre y la fila lo marca aparte.

export const SUPERADMIN_PREFIX = 'superadmin.';

const ACTION_LABELS: Readonly<Record<string, string>> = {
  // Consola del super-admin
  'business.created': 'Negocio dado de alta',
  'business.updated': 'Datos del negocio cambiados',
  'business.paused': 'Negocio en pausa',
  'business.resumed': 'Negocio sin pausa',
  'venue.created': 'Local dado de alta',
  'venue.profile_updated': 'Perfil del local cambiado',
  'venue.rules_updated': 'Reglas del local cambiadas',
  'venue.settlement_account_set': 'IBAN del local puesto',
  'venue.settlement_account_cleared': 'IBAN del local quitado',
  'venue.paused': 'Local en pausa',
  'venue.resumed': 'Local sin pausa',
  'venue.business_assigned': 'Local cambiado de negocio',
  'user.created': 'Persona dada de alta',
  'user.password_reset': 'Contraseña restablecida',
  'user.disabled': 'Persona dada de baja',
  'user.enabled': 'Persona dada de alta otra vez',
  'user.sessions_revoked': 'Sesiones cerradas',
  'user.totp_reset': '2FA quitada',
  'user.super_admin_granted': 'Permiso de super-admin dado',
  'user.super_admin_revoked': 'Permiso de super-admin quitado',
  'payout_account.revealed': 'Cuenta de cobro vista entera',
  'payout_account.updated': 'Cuenta de cobro cambiada',
  'wallet.blocked': 'Saldo bloqueado',
  'wallet.unblocked': 'Saldo desbloqueado',
  'wallet.pin_unlocked': 'PIN del saldo desbloqueado',
  'wallet.relinked': 'Enlace nuevo del saldo',
  'step_up.failed': 'Código 2FA fallido',
  'settlement.generated': 'Liquidación OxioPay emitida',
  'settlement.regenerated': 'Liquidación OxioPay regenerada',
  'settlement.paid': 'Liquidación OxioPay pagada',
  'settlement.paid_partially': 'Liquidación OxioPay pagada en parte',
  'settlement.voided': 'Liquidación OxioPay anulada',
  'settlement.payee_updated': 'Cuenta de OxioPay cambiada',
  'settlement.start_week_set': 'Semana de inicio de las liquidaciones fijada',
  'settlement.start_week_updated': 'Semana de inicio de las liquidaciones cambiada',

  // Entradas y sesiones
  'auth.login.ok': 'Entró',
  'auth.login.failed': 'Intento de entrada fallido',
  'auth.login.locked': 'Entrada bloqueada (demasiados intentos)',
  'auth.logout': 'Salió',
  'auth.refresh.ok': 'Sesión renovada',
  'auth.refresh.reuse_detected': 'Sesión cerrada por un enlace reutilizado',
  'auth.refresh.password_changed': 'Sesión cerrada por cambio de contraseña',
  'auth.sessions.revoked': 'Sesiones cerradas',
  'auth.switch_tenant': 'Cambió de local',
  'auth.totp.enabled': '2FA activada',
  'auth.totp.disabled': '2FA desactivada',

  // Cobros, devoluciones y noches
  'payment.manual_reconcile': 'Cobro cuadrado a mano',
  'refund.created': 'Devolución hecha',
  'refund.failed': 'Devolución fallida',
  'refund.outcome_unknown': 'Devolución sin confirmar',
  'refund.pending_resolved': 'Devolución pendiente resuelta',
  'refund.settle_failed': 'Devolución sin liquidar',
  'refund.bank_registered': 'Devolución apuntada desde el banco',
  'refund.earning_reverse_failed': 'Comisión sin descontar tras devolución',
  'night.opened': 'Noche abierta',
  'night.closed': 'Noche cerrada',
  'incident.acked': 'Incidencia vista',
  'bank_statement.imported': 'Extracto del banco importado',

  // Chicas
  'operator.created': 'Compañera dada de alta',
  'operator.updated': 'Datos de la compañera cambiados',
  'operator.invite.accepted': 'Invitación aceptada',
  'operator.invite.regenerated': 'Invitación nueva',
  'operator.password.reset': 'Contraseña de la compañera restablecida',
  'operator.payout.created': 'Pago a compañera apuntado',
  'operator.payout.batch': 'Pagos a compañeras apuntados de una vez',
  'operator.payout.verified': 'Pago a compañera verificado',
  'operator.payout.confirmed_manual': 'Pago a compañera confirmado a mano',
  'operator.self_onboarding.submitted': 'Ficha de la compañera enviada',
  'operator.self_onboarding_link.created': 'Enlace de alta de compañera creado',

  // Saldo de clientes (desde el local)
  'wallet.payout': 'Saldo devuelto al cliente',
  'wallet.merged': 'Saldos juntados',
  'wallet.pin_set': 'PIN del saldo puesto',
  'wallet.pin_reset': 'PIN del saldo borrado',
  'wallet.card_linked': 'Ficha NFC vinculada',
  'wallet.card_blocked': 'Ficha NFC bloqueada',
  'wallet.close_requested': 'Cliente pidió «Me voy»',
  'wallet.charge_without_faceid': 'Cobro del saldo sin Face ID',
  'wallet.consumption.reversed': 'Consumo del saldo devuelto',
  'wallet.credit_skipped_critical': 'Recarga sin sumar al saldo',

  // Local, carta y datáfonos
  'venue.settings.updated': 'Ajustes del local cambiados',
  'carta.item.created': 'Producto de la carta creado',
  'carta.item.updated': 'Producto de la carta cambiado',
  'terminal.created': 'Datáfono dado de alta',
  'terminal.bulk_created': 'Datáfonos dados de alta',
  'terminal.updated': 'Datáfono cambiado',
  'terminal.pairing_code.created': 'Código para emparejar datáfono',
  'terminal.device.paired': 'Datáfono emparejado',
  'terminal.device.unpaired': 'Datáfono desemparejado',
  'terminal.device.token_rotated': 'Clave del datáfono renovada',
};

/** Primer trozo de la acción → de qué va (para lo que no está en la lista). */
const AREA_LABELS: Readonly<Record<string, string>> = {
  auth: 'Sesión',
  business: 'Negocio',
  venue: 'Local',
  user: 'Persona',
  operator: 'Compañera',
  payout_account: 'Cuenta de cobro',
  wallet: 'Saldo',
  payment: 'Cobro',
  refund: 'Devolución',
  night: 'Noche',
  incident: 'Incidencia',
  terminal: 'Datáfono',
  carta: 'Carta',
  bank_statement: 'Banco',
  step_up: '2FA',
  settlement: 'Liquidación OxioPay',
};

export function isSuperAdminAction(action: string): boolean {
  return action.startsWith(SUPERADMIN_PREFIX);
}

/** "superadmin.venue.paused" → "Local en pausa"; lo desconocido, legible ("Saldo: algo nuevo"). */
export function auditActionLabel(action: string): string {
  const base = isSuperAdminAction(action) ? action.slice(SUPERADMIN_PREFIX.length) : action;
  const known = ACTION_LABELS[base];
  if (known) return known;
  const [area, ...rest] = base.split('.');
  const what = rest.join(' ').replace(/_/g, ' ').trim();
  const areaLabel = area ? AREA_LABELS[area] : undefined;
  if (areaLabel) return what ? `${areaLabel}: ${what}` : areaLabel;
  return base.replace(/[._]/g, ' ').trim() || action;
}

/** Filtro «Qué» del registro: prefijos de acción con nombre. */
export const AUDIT_ACTION_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Todo' },
  { value: 'superadmin.', label: 'Cambios del super-admin' },
  { value: 'superadmin.step_up.failed', label: 'Códigos 2FA fallidos' },
  { value: 'superadmin.settlement.', label: 'Liquidaciones OxioPay' },
  { value: 'auth.login', label: 'Entradas' },
  { value: 'auth.', label: 'Sesiones y 2FA' },
  { value: 'refund.', label: 'Devoluciones' },
  { value: 'operator.payout', label: 'Pagos a compañeras' },
  { value: 'operator.', label: 'Compañeras' },
  { value: 'wallet.', label: 'Saldo de clientes' },
  { value: 'night.', label: 'Noches' },
  { value: 'venue.', label: 'Ajustes del local' },
  { value: 'terminal.', label: 'Datáfonos' },
];

/** Qué datos del registro se pueden enseñar como «motivo» (si los hay). */
export function auditReason(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}
