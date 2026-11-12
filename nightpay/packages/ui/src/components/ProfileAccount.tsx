'use client';

import { useState, type FormEvent } from 'react';
import { ChangePasswordSchema, UpdateEmailSchema, UpdatePhoneSchema, type MyProfile, type ProfileApi } from '@nightpay/contracts';
import { Button } from './Button';
import { Input } from './Input';
import { errorText } from './ProfileIdentity';
import { Notice, ProfileBlock, actionsStyle, rowStyle, touchButton } from './profile-parts';

type Msg = { kind: 'ok' | 'error'; text: string } | null;
const firstIssue = (r: { success: false; error: { issues: Array<{ message: string }> } }): string => r.error.issues[0]?.message ?? 'Revisa lo que has escrito.';

/** «Contacto»: el teléfono y el correo con el que entra (cambiarlo pide la contraseña actual). */
export function ProfileContact({ profile, api, onChange }: { profile: MyProfile; api: ProfileApi; onChange: (next: MyProfile) => void }) {
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<Msg>(null);
  const [editingEmail, setEditingEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState<Msg>(null);

  const phoneCheck = UpdatePhoneSchema.safeParse({ phone });
  const phoneError = phone.trim() !== '' && !phoneCheck.success ? firstIssue(phoneCheck) : undefined;
  const phoneChanged = phoneCheck.success && phoneCheck.data.phone !== (profile.phone ?? null);

  async function savePhone(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (phoneBusy || !phoneCheck.success || !phoneChanged) return;
    setPhoneBusy(true);
    setPhoneMsg(null);
    try {
      const next = await api.setPhone(phone);
      onChange(next);
      setPhone(next.phone ?? '');
      setPhoneMsg({ kind: 'ok', text: next.phone ? 'Teléfono guardado.' : 'Teléfono quitado.' });
    } catch (err) {
      setPhoneMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setPhoneBusy(false);
    }
  }

  async function saveEmail(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (emailBusy) return;
    const check = UpdateEmailSchema.safeParse({ email, currentPassword: password });
    if (!check.success) return setEmailMsg({ kind: 'error', text: firstIssue(check) });
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      onChange(await api.setEmail(check.data.email, password));
      setEditingEmail(false);
      setEmail('');
      setPassword('');
      setEmailMsg({ kind: 'ok', text: 'Correo cambiado. Desde ahora entras con el nuevo; las sesiones de otros móviles se han cerrado.' });
    } catch (err) {
      setPassword('');
      setEmailMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <ProfileBlock title="Contacto">
      <form onSubmit={(e) => void savePhone(e)} style={rowStyle} noValidate>
        <Input
          label="Teléfono"
          hint="Español o internacional, por ejemplo +34 600 123 456."
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setPhoneMsg(null);
          }}
          error={phoneError}
          size="lg"
        />
        <div style={actionsStyle}>
          <Button type="submit" variant="ghost" style={touchButton} loading={phoneBusy} disabled={!phoneChanged}>
            Guardar teléfono
          </Button>
        </div>
        {phoneMsg ? <Notice kind={phoneMsg.kind}>{phoneMsg.text}</Notice> : null}
      </form>

      <div style={rowStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
          <span style={{ fontSize: 'var(--np-fs-14)', color: 'var(--np-text-label)' }}>Correo con el que entras</span>
          <b style={{ fontSize: 'var(--np-fs-16)', fontWeight: 600, overflowWrap: 'anywhere' }}>{profile.email}</b>
        </div>
        {editingEmail ? (
          <form onSubmit={(e) => void saveEmail(e)} style={rowStyle} noValidate>
            <Input
              label="Correo nuevo"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailMsg(null);
              }}
              size="lg"
            />
            <Input
              label="Tu contraseña de ahora"
              hint="Hace falta para cambiar el correo."
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setEmailMsg(null);
              }}
              size="lg"
            />
            <div style={actionsStyle}>
              <Button type="submit" variant="ghost" style={touchButton} loading={emailBusy}>
                Guardar correo
              </Button>
              <Button type="button" variant="ghost" style={touchButton} disabled={emailBusy} onClick={() => setEditingEmail(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        ) : (
          <div style={actionsStyle}>
            <Button
              variant="ghost"
              style={touchButton}
              onClick={() => {
                setEditingEmail(true);
                setEmailMsg(null);
              }}
            >
              Cambiar correo
            </Button>
          </div>
        )}
        {emailMsg ? <Notice kind={emailMsg.kind}>{emailMsg.text}</Notice> : null}
      </div>
    </ProfileBlock>
  );
}

/** «Seguridad»: cambiar la contraseña (con la actual) y cerrar la sesión de este móvil. */
export function ProfileSecurity({ api, onLogout }: { api: ProfileApi; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const input = { currentPassword: current, newPassword: next, newPasswordRepeat: repeat };
    const check = ChangePasswordSchema.safeParse(input);
    if (!check.success) return setMsg({ kind: 'error', text: firstIssue(check) });
    setBusy(true);
    setMsg(null);
    try {
      const done = await api.changePassword(input);
      setOpen(false);
      setCurrent('');
      setNext('');
      setRepeat('');
      setMsg({
        kind: 'ok',
        text: done.otherSessionsClosed > 0 ? 'Contraseña cambiada. Se han cerrado tus sesiones en otros móviles.' : 'Contraseña cambiada.',
      });
    } catch (err) {
      setCurrent('');
      setMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ProfileBlock title="Seguridad">
      {open ? (
        <form onSubmit={(e) => void save(e)} style={rowStyle} noValidate>
          <Input label="Contraseña de ahora" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} size="lg" />
          <Input
            label="Contraseña nueva"
            hint="Al menos 8 caracteres."
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            size="lg"
          />
          <Input label="Repite la contraseña nueva" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} size="lg" />
          <div style={actionsStyle}>
            <Button type="submit" variant="ghost" style={touchButton} loading={busy}>
              Guardar contraseña
            </Button>
            <Button type="button" variant="ghost" style={touchButton} disabled={busy} onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <div style={actionsStyle}>
          <Button
            variant="ghost"
            style={touchButton}
            onClick={() => {
              setOpen(true);
              setMsg(null);
            }}
          >
            Cambiar contraseña
          </Button>
        </div>
      )}
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
      <div style={actionsStyle}>
        <Button variant="ghost" style={touchButton} onClick={onLogout}>
          Cerrar sesión
        </Button>
      </div>
    </ProfileBlock>
  );
}
