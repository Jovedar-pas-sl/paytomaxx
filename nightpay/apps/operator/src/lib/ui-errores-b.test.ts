import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// «Piezas II», parte B (ideas 51 y 52): las líneas rojas sueltas pasan a los
// dos sitios fijos. Lo que falla al hacer algo (el banco, la red), en FormError,
// sobre el botón, hasta el siguiente intento. Y «Esperando» deja de borrar sus
// errores a los 4 s: lo que salió bien (note) se va solo; un problema
// (FormError), no.

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = join(HERE, '../../../admin/src/components');
const COBRAR = join(HERE, '../components/cobrar');
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path);
  }
  return out;
}
const rel = (path: string, base: string) => path.slice(base.length + 1);

/** La expresión del encargo: un role="alert" pintado de rojo a mano, o con su constante de estilo. */
const LOOSE_RED = /role="alert"[^>]*style=\{\{[^}]*np-danger|style=\{(errorStyle|errStyle)\}/;

describe('el panel: ninguna línea roja suelta', () => {
  const files = sources(ADMIN);

  it('ningún role="alert" rojo a mano ni style={errorStyle | errStyle} (eran 47 en 32 ficheros)', () => {
    const left = files.filter((f) => LOOSE_RED.test(read(f))).map((f) => rel(f, ADMIN));
    expect(left).toEqual([]);
  });

  it('ni constantes errorStyle / errStyle, ni np-set-error, ni np-approval-error', () => {
    const left = files
      .filter((f) => /\b(errorStyle|errStyle)\b|np-set-error|np-approval-error/.test(read(f)))
      .map((f) => rel(f, ADMIN));
    expect(left).toEqual([]);
    const css = ['panel-settings.css', 'panel-approvals.css'].map((f) => read(join(ADMIN, '../styles', f))).join('\n');
    expect(css).not.toMatch(/np-set-error|np-approval-error/);
  });

  it('los que había, ahora con FormError: los de los ajustes, reservas, aprobaciones, la plantilla de la carta y la búsqueda por teléfono', () => {
    for (const file of [
      'settings/SettingsBits.tsx',
      'settings/HomeTopUpPanel.tsx',
      'reservations/PackagesEditor.tsx',
      'reservations/ReservationsLinkCard.tsx',
      'reservations/ReservationCard.tsx',
      'reservations/NightList.tsx',
      'reservations/PromotersCard.tsx',
      'reservations/ReservationsPanel.tsx',
      'party/CierreSection.tsx',
      'party/StallsSection.tsx',
      'ApprovalsPanel.tsx',
      'CartaTemplate.tsx',
      'WalletPhoneSearch.tsx',
    ])
      expect(read(join(ADMIN, file)), file).toContain('<FormError>');
    expect(read(join(ADMIN, 'CartaTemplate.tsx'))).not.toContain('data-tone="danger"');
    expect(read(join(ADMIN, 'WalletPhoneSearch.tsx'))).not.toContain('np-danger');
    expect(read(join(ADMIN, 'ApprovalsPanel.tsx')).match(/<FormError>/g)).toHaveLength(3);
  });

  it('las operaciones que el banco no dejó leer son un aviso que se queda (Banner warning), no una línea roja', () => {
    const src = read(join(ADMIN, 'BankReconPanel.tsx'));
    const at = src.indexOf('operaciones del fichero no se pudieron leer');
    expect(src.slice(src.lastIndexOf('<', src.lastIndexOf('{statement.skippedCount}', at)) - 40, at)).toContain('<Banner tone="warning">');
  });
});

describe('Cobrar: ningún styles.error; los errores, en FormError', () => {
  it('sin styles.error en cobrar/ (y sin su regla)', () => {
    const left = sources(COBRAR)
      .filter((f) => read(f).includes('styles.error'))
      .map((f) => rel(f, COBRAR));
    expect(left).toEqual([]);
    expect(read(join(COBRAR, 'cobrar.module.css'))).not.toMatch(/^\.error \{/m);
  });

  it('el Notice de error del perfil pinta FormError', () => {
    const parts = read(join(HERE, '../../../../packages/ui/src/components/profile-parts.tsx'));
    const notice = parts.slice(parts.indexOf('export function Notice'), parts.indexOf('export const rowStyle'));
    expect(notice).toContain("if (kind === 'error') return <FormError>{children}</FormError>;");
  });
});

describe('Esperando: note se va sola; problem, no', () => {
  const src = read(join(COBRAR, 'Esperando.tsx'));

  it('sin TOAST_MS ni su toast: note (4 s) y problem', () => {
    expect(src).not.toContain('TOAST_MS');
    expect(src).not.toMatch(/\bsetToast\b/);
    expect(src).toContain('const NOTE_MS = 4000;');
    expect(src).toContain('const [note, setNote] = useState<string | null>(null);');
    expect(src).toContain('const [problem, setProblem] = useState<string | null>(null);');
  });

  it('un solo reloj que borra un mensaje: el de note', () => {
    expect(src.match(/setTimeout\(\(\) => set(Note|Problem)\(null\)/g)).toEqual(['setTimeout(() => setNote(null)']);
    expect(src).toContain('setTimeout(() => setNote(null), NOTE_MS)');
  });

  it('«Ya está pagado» y «comprobando» son note; lo que no se cobró, la ficha vacía, el NFC y no poder cancelar, problem', () => {
    expect(src).toContain("setNote('Ya está pagado')");
    expect(src).toContain('setNote(CHECKING_TEXT)');
    expect(src).toContain('setProblem(NOT_CHARGED_RETRY_TEXT)');
    expect(src).toMatch(/setProblem\(party \? 'Esta pulsera está vacía/);
    expect(src).toContain('const message = (err as Error).message;');
    expect(src).toContain('const failed = cancelFailedText(card, code);');
    expect(src).toContain('setProblem(failed);');
  });

  it('el problema se va al leer otra ficha o al tocar un botón; se pinta con FormError', () => {
    const listen = src.slice(src.indexOf('const read = await readCard('), src.indexOf('if (!read.token)'));
    expect(listen).toContain('setProblem(null);');
    expect(src).toMatch(/onClickCapture=\{clearProblemOnButton\}/);
    expect(src).toContain('{problem ? <FormError>{problem}</FormError> : null}');
  });
});

describe('Esperando: nunca dos mensajes que se contradicen ni un problema que ya no vale', () => {
  const src = read(join(COBRAR, 'Esperando.tsx'));

  it('al resolverse la comprobación se quita «Comprobando…» antes de decir que no llegó a cobrarse', () => {
    const poll = src.slice(src.indexOf('const fresh = await fetchSaldoState(chargeId, signal);'), src.indexOf('setProblem(NOT_CHARGED_RETRY_TEXT)'));
    expect(poll).toContain('if (checking) setNote((current) => (current === CHECKING_TEXT ? null : current));');
    expect(poll.indexOf('setNote(')).toBeLessThan(poll.indexOf("if (fresh.status !== 'PENDING') return 'stop';"));
  });

  it('al salir de la pantalla (la barra de pestañas la oculta sin desmontarla) se quita el problema', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\n\s+if \(!shown\) setProblem\(null\);\n\s+\}, \[shown\]\);/);
  });

  it('el reintento solo del NFC no tapa «No se ha podido cancelar»', () => {
    const retry = src.slice(src.indexOf("if ((err as Error).name === 'AbortError'"), src.indexOf('setTimeout(() => setNfcRound'));
    expect(retry).toContain('setProblem((current) => (current !== null && current === cancelFailedRef.current ? current : message));');
    expect(src).toContain('cancelFailedRef.current = failed;');
  });

  it('NO PAGADO con el QR abierto enseña el problema y lo quita al tocar un botón; retryError, igual', () => {
    const failed = src.slice(src.indexOf("if (outcome.kind === 'failed') {"), src.indexOf("if (outcome.kind === 'expired'"));
    expect(failed).toContain('<div onClickCapture={clearProblemOnButton}>');
    expect(failed).toContain('error={retryError ?? problem}');
  });
});
