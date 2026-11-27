import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// PR 3 B en el panel: «Movimientos», «Anular carga» y «Topes» de cada
// conexión, y el informe «Cargas de otras plataformas». Las pantallas se leen
// como texto (sin comentarios: solo cuenta lo que se ve); las llamadas al API,
// con authedFetch de mentira.

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');

const DIR = '../components/settings/partners/';
const MOVEMENTS = read(`${DIR}MovementsSheet.tsx`);
const VOID = read(`${DIR}VoidLoadSheet.tsx`);
const LIMITS = read(`${DIR}LimitsSheet.tsx`);
const PANEL = read(`${DIR}PartnersPanel.tsx`);
const LIB = read('./partner-connections.ts');

describe('«Movimientos»', () => {
  it('la noche de hoy por defecto, la anterior y la siguiente', () => {
    expect(MOVEMENTS).toContain('currentNight()');
    expect(MOVEMENTS).toContain('nightNav(');
    expect(MOVEMENTS).toContain('NIGHT_WINDOW_TEXT');
    expect(LIB).toContain("'La noche va de 08:00 a 08:00.'");
  });

  it('los totales, por cajero y lo que hay que contar', () => {
    expect(MOVEMENTS).toContain('statementTotals(');
    expect(MOVEMENTS).toContain('byDevice');
    expect(MOVEMENTS).toContain('Por cajero');
    expect(LIB).toContain("'Cuenta este efectivo en sus cajeros: tiene que dar el neto.'");
    expect(MOVEMENTS).toContain('COUNT_CASH_TEXT');
  });

  it('los estados: cargando, vacío, error con «Reintentar», «Ver más» y «Anular carga»', () => {
    expect(MOVEMENTS).toContain('<Skeleton');
    expect(LIB).toContain("'Esta noche no hay cargas.'");
    expect(MOVEMENTS).toContain('NO_LOADS_TEXT');
    expect(MOVEMENTS).toContain("label: 'Reintentar'");
    expect(MOVEMENTS).toContain('Ver más');
    expect(MOVEMENTS).toContain('nextCursor');
    expect(MOVEMENTS).toContain('Anular carga');
    expect(MOVEMENTS).toContain('canVoidLoad(');
    expect(MOVEMENTS).toContain('loadState(');
    expect(MOVEMENTS).toContain('codeHint');
  });

  it('lo que escribe la plataforma, como texto', () => {
    for (const src of [MOVEMENTS, VOID, LIMITS, PANEL]) expect(src).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('«Anular carga»', () => {
  it('el motivo, la 2FA de esa carga y lo que pasa', () => {
    expect(VOID).toContain("useSecondFactor(stepUpActions.partner('void', load.id), true, 'Ahora pulsa «Anular carga».'");
    expect(VOID).toContain('voidReasonProblem(');
    expect(VOID).toContain('voidLoadWarning(');
    expect(VOID).toContain('maxLength={140}');
    expect(VOID).toContain('voidPartnerLoad(');
    expect(VOID).toContain('<FormError>');
  });

  it('sale bien: «Carga anulada.» y la lista se vuelve a leer', () => {
    expect(LIB).toContain("LOAD_VOIDED_NOTICE = 'Carga anulada.'");
    expect(MOVEMENTS).toMatch(/toast\.show\(LOAD_VOIDED_NOTICE/);
    expect(MOVEMENTS).toMatch(/onDone=\{\(\) => \{[\s\S]*?reload\(\);/);
  });
});

describe('«Topes»', () => {
  it('los tres, con sus máximos, el consejo y la 2FA solo al subir', () => {
    expect(LIMITS).toContain('LOAD_CAPS');
    expect(LIMITS).toContain('LIMITS_START_TEXT');
    expect(LIB).toContain("'Si los cajeros se vacían menos de una vez al día, empieza con 2.000 € por noche.'");
    expect(LIMITS).toContain('limitsStepUpAction(');
    expect(LIMITS).toMatch(/useSecondFactor\([^)]*raises/);
    expect(LIMITS).toContain('PARTNER_LIMITS_CHANGED');
    expect(LIMITS).toContain('fetchPartnerConnections(');
  });

  it('en la ficha: los botones abren sus hojas', () => {
    expect(PANEL).toContain('<MovementsSheet');
    expect(PANEL).toContain('<LimitsSheet');
  });
});

describe('Informes: «Cargas de otras plataformas», solo con la API de socios', () => {
  const REPORTS = read('../components/ReportsPanel.tsx');
  const DASHBOARD = read('../components/Dashboard.tsx');

  it('el informe y su texto', () => {
    expect(REPORTS).toContain("kind: 'recargas-socios'");
    expect(REPORTS).toContain("title: 'Cargas de otras plataformas'");
    expect(REPORTS).toContain("detail: 'Cada carga de los cajeros de otras plataformas y cada anulación, en negativo, con su cajero.'");
    expect(REPORTS).toContain('partnersOn');
    expect(read('./endpoints/payments.ts')).toContain("'recargas-socios'");
  });

  it('el Dashboard le pasa partnersOn', () => {
    expect(DASHBOARD).toMatch(/<ReportsPanel isOwner=\{isOwner\} partnersOn=\{[^}]+\} \/>/);
  });
});

describe('las llamadas al API', () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];

  afterEach(() => {
    calls.length = 0;
    vi.resetModules();
    vi.doUnmock('./http');
  });

  async function endpoints(body: unknown = {}) {
    vi.doMock('./http', () => ({
      authedFetch: async (path: string, init: RequestInit = {}) => {
        calls.push({ path, init });
        return new Response(JSON.stringify(body), { status: 200 });
      },
      totpAwareError: async (res: Response) => new Error(String(res.status)),
    }));
    return import('./endpoints/partner-connections');
  }

  const ID = '11111111-1111-4111-8111-111111111111';
  const LOAD = '33333333-3333-4333-8333-333333333333';

  it('las cargas de una noche, con su cursor', async () => {
    const api = await endpoints({ loads: [], nextCursor: null });
    await api.fetchPartnerLoads(ID, { businessDate: '2026-11-26', cursor: null });
    await api.fetchPartnerLoads(ID, { businessDate: '2026-11-26', cursor: 'abc+/=' });
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/admin/partner-connections/${ID}/loads?business_date=2026-11-26`,
      `/v1/admin/partner-connections/${ID}/loads?business_date=2026-11-26&cursor=abc%2B%2F%3D`,
    ]);
  });

  it('el resumen de una noche', async () => {
    const api = await endpoints({});
    await api.fetchPartnerStatement(ID, '2026-11-26');
    expect(calls[0]!.path).toBe(`/v1/admin/partner-connections/${ID}/statement?business_date=2026-11-26`);
  });

  it('anular: POST con el motivo y el código', async () => {
    const api = await endpoints({});
    await api.voidPartnerLoad(ID, LOAD, 'no pagó', { totpCode: '123456' });
    expect(calls[0]!.path).toBe(`/v1/admin/partner-connections/${ID}/loads/${LOAD}/void`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ reason: 'no pagó', totpCode: '123456' });
  });

  it('los topes: PATCH; sin código si no hace falta, con la llave en la cabecera', async () => {
    const api = await endpoints({});
    const body = { perOperationCents: 30000, walletDayCents: 60000, nightCents: 200000 };
    await api.updatePartnerLimits(ID, body, {});
    await api.updatePartnerLimits(ID, body, { stepUpToken: 'tok' });
    expect(calls[0]!.path).toBe(`/v1/admin/partner-connections/${ID}/limits`);
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
    expect(calls[1]!.init.headers).toEqual({ 'X-Step-Up-Token': 'tok' });
  });
});
