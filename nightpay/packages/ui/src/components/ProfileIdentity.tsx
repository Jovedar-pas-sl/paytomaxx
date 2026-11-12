'use client';

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { UpdateProfileSchema, type MyProfile, type ProfileApi } from '@nightpay/contracts';
import { prepareProfilePhoto } from '../lib/profile-photo';
import { Button } from './Button';
import { Input } from './Input';
import { Notice, ProfileBlock, actionsStyle, rowStyle, touchButton } from './profile-parts';
import { StaffAvatar } from './StaffAvatar';

export const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'No se ha podido guardar. Vuelve a intentarlo.');

type Msg = { kind: 'ok' | 'error'; text: string } | null;

/** «Tu foto y tu nombre»: la foto en grande (cambiar o quitar) y el nombre que ven los demás. */
export function ProfileIdentity({ profile, api, onChange }: { profile: MyProfile; api: ProfileApi; onChange: (next: MyProfile) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(profile.displayName ?? '');
  const [busy, setBusy] = useState<'photo' | 'name' | null>(null);
  const [photoMsg, setPhotoMsg] = useState<Msg>(null);
  const [nameMsg, setNameMsg] = useState<Msg>(null);

  const parsed = UpdateProfileSchema.safeParse({ displayName: name });
  const nameError = name !== '' && !parsed.success ? (parsed.error.issues[0]?.message ?? 'Revisa el nombre.') : undefined;
  const changed = name !== (profile.displayName ?? '');

  async function pickPhoto(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy('photo');
    setPhotoMsg(null);
    try {
      const ready = await prepareProfilePhoto(file);
      onChange(await api.setPhoto(ready.base64));
      setPhotoMsg({ kind: 'ok', text: 'Foto guardada.' });
    } catch (err) {
      setPhotoMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function removePhoto(): Promise<void> {
    if (busy) return;
    setBusy('photo');
    setPhotoMsg(null);
    try {
      onChange(await api.removePhoto());
      setPhotoMsg({ kind: 'ok', text: 'Foto quitada.' });
    } catch (err) {
      setPhotoMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function saveName(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !parsed.success || !changed) return;
    setBusy('name');
    setNameMsg(null);
    try {
      onChange(await api.setName(parsed.data.displayName));
      setNameMsg({ kind: 'ok', text: 'Nombre guardado.' });
    } catch (err) {
      setNameMsg({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <ProfileBlock title="Tu foto y tu nombre">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
        <StaffAvatar userId={profile.userId} hash={profile.photoHash} name={profile.displayName} size={112} />
        <input ref={fileRef} type="file" accept="image/*" onChange={(e) => void pickPhoto(e)} hidden aria-label="Elegir una foto" />
        <div style={{ ...actionsStyle, justifyContent: 'center' }}>
          <Button variant="ghost" style={touchButton} loading={busy === 'photo'} onClick={() => fileRef.current?.click()}>
            Cambiar foto
          </Button>
          {profile.hasPhoto ? (
            <Button variant="ghost" style={touchButton} disabled={busy !== null} onClick={() => void removePhoto()}>
              Quitar foto
            </Button>
          ) : null}
        </div>
        {photoMsg ? <Notice kind={photoMsg.kind}>{photoMsg.text}</Notice> : null}
      </div>
      <form onSubmit={(e) => void saveName(e)} style={rowStyle} noValidate>
        <Input
          label="El nombre que ven los demás"
          hint="De 2 a 40 letras. Es el que sale en los cobros y en las listas."
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameMsg(null);
          }}
          error={nameError}
          autoComplete="nickname"
          maxLength={60}
          size="lg"
        />
        <div style={actionsStyle}>
          <Button type="submit" variant="primary" style={touchButton} loading={busy === 'name'} disabled={!changed || !parsed.success}>
            Guardar
          </Button>
        </div>
        {nameMsg ? <Notice kind={nameMsg.kind}>{nameMsg.text}</Notice> : null}
      </form>
    </ProfileBlock>
  );
}
