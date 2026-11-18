import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisplayMessagePreview } from './DisplayMessageCard';

describe('vista previa del reposo de la pantalla del cliente', () => {
  it('el nombre del local y el mensaje debajo, como en la tablet', () => {
    const html = renderToStaticMarkup(
      <DisplayMessagePreview venueName="Sala Luna" message={{ line1: '2x1 en copas', line2: 'Sábado: fiesta blanca' }} />,
    );
    expect(html).toContain('Sala Luna');
    expect(html).toContain('2x1 en copas');
    expect(html).toContain('Sábado: fiesta blanca');
    expect(html).toContain('data-theme="dark"');
  });

  it('sin mensaje, solo el nombre; el texto se enseña como texto (nunca como HTML)', () => {
    const empty = renderToStaticMarkup(<DisplayMessagePreview venueName="Sala Luna" message={{ line1: null, line2: null }} />);
    expect(empty).toContain('Sala Luna');
    expect(empty).not.toContain('np-dm-msg');
    const html = renderToStaticMarkup(
      <DisplayMessagePreview venueName="Sala Luna" message={{ line1: '<img src=x onerror=alert(1)>', line2: null }} />,
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('está en Ajustes → Carta (dueño y encargado) y habla con /v1/customer-display/message', () => {
    const carta = readFileSync(new URL('../CartaPanel.tsx', import.meta.url), 'utf8');
    expect(carta).toContain('<DisplayMessageCard />');
    const api = readFileSync(new URL('../../lib/endpoints/settings.ts', import.meta.url), 'utf8');
    expect(api).toContain("'/v1/customer-display/message'");
  });
});
