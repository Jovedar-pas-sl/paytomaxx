import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KeyIssuedBody } from './KeyIssuedSheet';

// Lo que se ve una vez tras conectar o cambiar la clave.

const KEY = `oxp_live_${'0123456789abcdef'.repeat(3)}`;
const noop = () => undefined;
const render = (props: Partial<Parameters<typeof KeyIssuedBody>[0]>) =>
  renderToStaticMarkup(
    <KeyIssuedBody
      outcome={{ kind: 'key', key: KEY }}
      partnerName="Cajeros Demo"
      keyHint="oxp_live_…cdef"
      timezone="Europe/Madrid"
      shown={false}
      onToggle={noop}
      onCopy={noop}
      {...props}
    />,
  );

describe('la clave, una vez', () => {
  it('oculta hasta pulsar «Ver», con «Copiar» y cómo termina', () => {
    const html = render({});
    expect(html).not.toContain(KEY);
    expect(html).toContain('Copiar');
    expect(html).toContain('>Ver<');
    expect(html).toContain('Termina en cdef.');
    expect(html).toContain('no se puede volver a ver');
  });

  it('con «Ver», entera y en monoespaciada', () => {
    const html = render({ shown: true });
    expect(html).toMatch(new RegExp(`<code class="np-ptn-key"[^>]*>${KEY}</code>`));
    expect(html).toContain('>Ocultar<');
  });

  it('por correo: a quién llegó el enlace, sin clave', () => {
    const html = render({ outcome: { kind: 'sent', sentTo: 'o***@cajeros.example', expiresAt: '2026-11-27T17:30:00.000Z' } });
    expect(html).toContain('o***@cajeros.example');
    expect(html).toContain('se abre una sola vez');
    expect(html).not.toContain('oxp_');
  });

  it('si el correo no salió: cambiarla otra vez, con «La copio yo»', () => {
    const html = render({ outcome: { kind: 'failed' }, onRotate: noop });
    expect(html).toContain('El correo no salió');
    expect(html).toContain('Cambiar clave');
    expect(html).toContain('La copio yo');
  });
});
