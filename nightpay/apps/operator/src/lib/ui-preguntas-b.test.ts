import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// «Piezas II», parte B (idea 49): las 10 preguntas grises del panel
// (window.confirm) pasan a la pregunta de la app (useConfirm → ConfirmDialog),
// con las mismas palabras; y las ventanas que mueven dinero ordenan su pie como
// ella: en el DOM, primero «Volver» y después la acción (hasta 640 px, la
// acción arriba), los dos grandes. Pasos, 2FA y texto de la acción, igual.

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS = join(HERE, '../../..');
const ADMIN = join(APPS, 'admin/src/components');
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const admin = (rel: string): string => read(join(ADMIN, rel));

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.next') sources(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('ninguna pregunta gris del navegador', () => {
  it('ningún window.confirm en apps/*/src', () => {
    const found = readdirSync(APPS)
      .flatMap((app) => {
        try {
          return sources(join(APPS, app, 'src'));
        } catch {
          return [];
        }
      })
      .filter((path) => /window\.confirm\s*\(/.test(read(path)));
    expect(found).toEqual([]);
  });
});

describe('los 10 sitios: la pregunta de la app, con su botón y su «no»', () => {
  const SITES: Array<{ file: string; labels: string[] }> = [
    { file: 'fichas/WalletFichaModal.tsx', labels: ["confirmLabel: 'Bloquear ficha'", "cancelLabel: 'No bloquear'"] },
    { file: 'WalletsPanel.tsx', labels: ["confirmLabel: 'Bloquear ficha'", "cancelLabel: 'No bloquear'"] },
    { file: 'FichasPanel.tsx', labels: ["'Marcar perdida'", "'Bloquear ficha'", "'No bloquear'"] },
    { file: 'TerminalsPanel.tsx', labels: ["confirmLabel: 'Desvincular'"] },
    {
      file: 'party/PulserasSection.tsx',
      labels: [
        'confirmLabel: `Preparar ${n} pulseras`',
        "tone: 'primary'",
        "confirmLabel: 'Bloquear pulsera'",
        "cancelLabel: 'No bloquear'",
        "confirmLabel: 'Bloquear y pasar saldo'",
        'body: REPLACE_PULSERA_BODY',
      ],
    },
    { file: 'party/DevolucionesSection.tsx', labels: ["'Sí, marcar hecha'", "'Todavía no'", "'Anular devolución'", 'sepaAgainConfirm'] },
    { file: 'party/CierreSection.tsx', labels: ['sepaAgainConfirm'] },
  ];

  for (const { file, labels } of SITES) {
    it(file, () => {
      const src = admin(file);
      expect(src).not.toContain('window.confirm');
      expect(src).toMatch(/useConfirm\(\)/);
      // La del SEPA ya viene partida (sepaAgainConfirm); las demás son el texto de hoy, partido.
      if (file !== 'party/CierreSection.tsx') expect(src).toContain('splitQuestion(');
      for (const label of labels) expect(src).toContain(label);
    });
  }

  it('las 3 de PulserasSection, las 2 de Devoluciones y su SEPA: 10 en total', () => {
    const count = (file: string) => admin(file).match(/await confirm\(|sepaAgainConfirm\(confirm/g)?.length ?? 0;
    expect(count('party/PulserasSection.tsx')).toBe(3);
    expect(count('party/DevolucionesSection.tsx')).toBe(2);
    expect(count('party/CierreSection.tsx')).toBe(1);
    expect(['fichas/WalletFichaModal.tsx', 'WalletsPanel.tsx', 'FichasPanel.tsx', 'TerminalsPanel.tsx'].map(count)).toEqual([1, 1, 1, 1]);
  });

  it('SEPA: «¿Descargar otra vez el fichero?», «Descargar otra vez» · «No descargar»; la pregunta puede esperar (promesa)', () => {
    const lib = read(join(APPS, 'admin/src/lib/sepa-again.ts'));
    expect(lib).toContain("SEPA_AGAIN_TITLE = '¿Descargar otra vez el fichero?'");
    expect(lib).toContain('title: SEPA_AGAIN_TITLE');
    expect(lib).toContain("confirmLabel: 'Descargar otra vez'");
    expect(lib).toContain("cancelLabel: 'No descargar'");
    expect(lib).toContain('ask: (body: string) => boolean | Promise<boolean>');
  });

  it('en la ficha del saldo, la pregunta va en `overlays` de FichaSheet y la tapa (covered)', () => {
    const src = admin('fichas/WalletFichaModal.tsx');
    expect(src).toContain('covered={dialog !== null}');
    expect(src).toContain('overlays={dialog}');
  });

  it('la guía (Tour) no sale con una pregunta abierta: cuenta también alertdialog', () => {
    const tour = read(join(APPS, '../packages/ui/src/components/Tour.tsx'));
    const fn = tour.slice(tour.indexOf('function otherDialogOpen'), tour.indexOf('export interface UseTour'));
    expect(fn).toContain('[role="alertdialog"][aria-modal="true"]');
    expect(fn).toContain('[role="dialog"][aria-modal="true"]');
  });
});

/** El pie (np-pregunta-pie) que lleva esa acción: sus botones en el orden del DOM. */
function foot(src: string, action: string): Array<{ attrs: string; text: string }> {
  // La última vez que sale: el texto de la acción también sale en las pistas y el título.
  const at = src.lastIndexOf(action);
  expect(at, `no está ${action}`).toBeGreaterThan(0);
  const start = src.lastIndexOf('className="np-pregunta-pie"', at);
  expect(start, `${action} sin np-pregunta-pie`).toBeGreaterThan(0);
  const block = src.slice(start, src.indexOf('</div>', at));
  return [...block.matchAll(/<Button\b([\s\S]*?)>([\s\S]*?)<\/Button>/g)].map((m) => ({ attrs: m[1]!, text: m[2]!.trim() }));
}

describe('las ventanas de dinero: el pie como el de la pregunta', () => {
  const WINDOWS: Array<{ file: string; action: string; variant: string }> = [
    { file: 'ReverseChargeModal.tsx', action: 'Anular cobro\n', variant: 'variant="danger"' },
    { file: 'RecentCashTopUps.tsx', action: 'Anular {formatEur(', variant: 'variant="danger"' },
    { file: 'PaymentModals.tsx', action: '{buttonText}', variant: "variant={asking ? 'primary' : 'danger'}" },
    { file: 'WalletModals.tsx', action: '`Devolver ${formatEur(amountCents)}`', variant: 'variant="danger"' },
    { file: 'BankRefundModal.tsx', action: 'Registrar devolución', variant: '' },
    { file: 'AcceptAfterCancelModal.tsx', action: 'Dar por bueno', variant: '' },
  ];

  for (const { file, action, variant } of WINDOWS) {
    it(`${file}: «Volver» (secundario) antes que la acción, los dos grandes`, () => {
      const buttons = foot(admin(file), action);
      expect(buttons).toHaveLength(2);
      expect(buttons[0]!.text).toBe('Volver');
      expect(buttons[0]!.attrs).toContain('variant="ghost"');
      expect(buttons[1]!.text).toContain(action.trim().replace(/\n$/, ''));
      for (const b of buttons) expect(b.attrs).toContain('size="lg"');
      if (variant) expect(buttons[1]!.attrs).toContain(variant);
    });
  }

  it('«Dejarlo» y «Cancelar» ya no están en esos pies', () => {
    for (const file of ['ReverseChargeModal.tsx', 'RecentCashTopUps.tsx', 'BankRefundModal.tsx']) expect(admin(file)).not.toMatch(/>\s*(Dejarlo|Cancelar)\s*</);
    expect(admin('PaymentModals.tsx').slice(admin('PaymentModals.tsx').indexOf('const buttonText'))).not.toMatch(/>\s*(Dejarlo|Cancelar)\s*</);
    const wallet = admin('WalletModals.tsx');
    const payout = wallet.slice(wallet.indexOf('export function PayoutModal'), wallet.indexOf('export function ChargeWithoutFaceIdModal'));
    expect(payout).not.toMatch(/>\s*Cancelar\s*</);
  });

  it('el pie de la pregunta, también dentro del cuerpo de una hoja (los botones de un formulario se quedan en él)', () => {
    const css = read(join(APPS, '../packages/ui/src/pieces-2.css'));
    expect(css).toContain('.np-hoja-body .np-pregunta-pie > .np-btn[data-size]');
  });
});
