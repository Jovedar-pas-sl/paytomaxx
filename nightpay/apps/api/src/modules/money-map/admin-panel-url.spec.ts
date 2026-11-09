import { describe, expect, it } from 'vitest';
import { adminPanelBaseUrl } from './admin-panel-url';

describe('la dirección del panel (enlace de «Compartir»)', () => {
  it('ADMIN_BASE_URL si está (sin barra final)', () => {
    expect(adminPanelBaseUrl({ adminBaseUrl: 'https://panel.sala.es/', apiUrl: 'https://api.paytomaxx.com', production: true })).toBe(
      'https://panel.sala.es',
    );
  });

  it('si no, la del API con «admin.» en vez de «api.»', () => {
    expect(adminPanelBaseUrl({ apiUrl: 'https://api.paytomaxx.com', production: true })).toBe('https://admin.paytomaxx.com');
    expect(adminPanelBaseUrl({ apiUrl: 'https://api.sala.es:8443/', production: true })).toBe('https://admin.sala.es:8443');
  });

  it('en local, el panel de desarrollo; en producción sin nada, sin enlace', () => {
    expect(adminPanelBaseUrl({ apiUrl: 'http://localhost:4100', production: false })).toBe('http://localhost:4103');
    expect(adminPanelBaseUrl({ apiUrl: 'https://pagos.sala.es', production: true })).toBeNull();
    expect(adminPanelBaseUrl({ apiUrl: 'no es una url', production: true })).toBeNull();
  });
});
