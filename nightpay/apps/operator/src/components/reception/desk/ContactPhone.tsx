'use client';

import { useId, useState, type FormEvent } from 'react';
import { CONTACT_PHONE_NOTE, normalizeContactPhone } from '@nightpay/contracts';
import { saveContactPhone } from '@/lib/reception-desk';
import l from './loaded.module.css';

/**
 * El teléfono opcional al dar una ficha nueva: se puede saltar (basta con
 * seguir). Solo para encontrar su saldo si lo pierde todo; no sale en
 * ninguna lista (lo ven el encargado y el dueño en el detalle del saldo).
 */
export function ContactPhoneField({ walletId }: { walletId: string }) {
  const id = useId();
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!normalizeContactPhone(phone)) return setError('Escribe solo las cifras (con el prefijo si es de fuera).');
    setState('saving');
    setError(null);
    try {
      await saveContactPhone(walletId, phone);
      setState('saved');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  }

  if (state === 'saved') {
    return (
      <p className={l.phoneSaved} role="status">
        Teléfono guardado. {CONTACT_PHONE_NOTE}.
      </p>
    );
  }
  return (
    <form className={l.phone} onSubmit={(e) => void save(e)}>
      <label htmlFor={id}>Teléfono (opcional)</label>
      <div className={l.phoneRow}>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          maxLength={20}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="600 12 34 56"
        />
        <button type="submit" disabled={state === 'saving' || phone.trim() === ''}>
          {state === 'saving' ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      <small>{CONTACT_PHONE_NOTE}</small>
      {error ? <small role="alert">{error}</small> : null}
    </form>
  );
}