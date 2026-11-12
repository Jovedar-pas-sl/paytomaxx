import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialsTone, StaffAvatar } from '../../../../packages/ui/src/components/StaffAvatar';
import { ProfileDevice } from '../../../../packages/ui/src/components/ProfileScreen';
import { Segmented } from '../../../../packages/ui/src/components/profile-parts';

// «Mi perfil»: el avatar (iniciales o foto) y las opciones de «Este móvil».
// Se pintan con react-dom/server: sin navegador, solo el marcado.

describe('StaffAvatar', () => {
  it('sin foto: las iniciales, en un círculo de su tamaño, con un nombre accesible', () => {
    const html = renderToStaticMarkup(<StaffAvatar userId="u1" name="Ana María López" size={42} />);
    expect(html).toContain('>AL<');
    expect(html).toContain('aria-label="Iniciales de Ana María López"');
    expect(html).toContain('width:42px');
    expect(html).toContain('border-radius:50%');
  });

  it('con una foto en memoria: una imagen con su texto alternativo', () => {
    const html = renderToStaticMarkup(<StaffAvatar userId="u1" name="Ana" src="blob:x" size={40} />);
    expect(html).toContain('<img');
    expect(html).toContain('src="blob:x"');
    expect(html).toContain('alt="Foto de Ana"');
  });

  it('sin nombre: un interrogante, y el mismo color siempre para la misma persona', () => {
    expect(renderToStaticMarkup(<StaffAvatar userId="u2" name={null} />)).toContain('>?<');
    expect(initialsTone('u1')).toBe(initialsTone('u1'));
    expect(initialsTone('abc')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('las iniciales usan la escala de letra, nunca menos de 14 px', () => {
    for (const size of [32, 42, 56, 112]) {
      expect(renderToStaticMarkup(<StaffAvatar userId="u1" name="Ana" size={size} />)).toMatch(/font-size:var\(--np-fs-(14|22|40)\)/);
    }
  });
});

describe('Este móvil', () => {
  it('el personal ve tema, vibrar y letra más grande; el panel, solo el tema', () => {
    const full = renderToStaticMarkup(<ProfileDevice mode="full" title="Este móvil" themeFallback="dark" />);
    expect(full).toContain('Este móvil');
    for (const label of ['Tema', 'Vibrar al tocar', 'Letra más grande', 'Oscuro', 'Claro', 'Como el móvil']) expect(full).toContain(label);
    const theme = renderToStaticMarkup(<ProfileDevice mode="theme" title="Este equipo" themeFallback="system" />);
    expect(theme).toContain('Este equipo');
    expect(theme).toContain('Tema');
    expect(theme).not.toContain('Vibrar');
    expect(theme).not.toContain('Letra más grande');
  });

  it('lo elegido va marcado (aria-checked) y en crema; el resto no', () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="Vibrar"
        value="no"
        options={[
          { value: 'yes', label: 'Sí' },
          { value: 'no', label: 'No' },
        ]}
        onChange={() => undefined}
      />,
    );
    expect(html).toMatch(/aria-checked="true"[^>]*>No</);
    expect(html).toMatch(/aria-checked="false"[^>]*>Sí</);
    expect(html).toContain('var(--np-chosen)');
    expect(html).toContain('min-height:2.75rem');
  });
});
