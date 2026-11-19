import { describe, expect, it, vi } from 'vitest';
import { legalFooter } from '../../legal/legal-links';
import { CHARGE_DISPUTED_ACTION, ChargeDisputeService, type NotMeResult, type NotMeView } from './charge-dispute.service';
import { renderNotMePage } from './charge-alert-view';
import { NOT_ME_TTL_MS, signNotMeToken } from './not-me-token';

const SECRET = 'j'.repeat(40);
const CHARGE = '11111111-2222-4333-8444-555555555555';
const WALLET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VENUE = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface Opts {
  status?: string;
  disputed?: boolean;
  cards?: Array<{ id: string; venueId: string | null }>;
  pinLockable?: boolean;
}

function harness(opts: Opts = {}) {
  const charge = {
    id: CHARGE, tenantId: VENUE, walletId: WALLET, status: opts.status ?? 'ACCEPTED', amountCents: 1_000, tipCents: 200, ref: 42,
    decidedAt: new Date('2026-11-16T22:40:00Z'), createdAt: new Date('2026-11-16T22:39:00Z'),
  };
  const sqlOf = (q: unknown) => (Array.isArray(q) ? (q as string[]).join('?') : String(q));
  const tx = {
    $queryRaw: vi.fn(async (q: unknown) => {
      const sql = sqlOf(q);
      if (sql.includes('FROM wallet_charge_requests')) return [charge];
      if (sql.includes('FROM audit_events')) return opts.disputed ? [{ one: 1 }] : [];
      if (sql.includes('"pinLockedAt" IS NOT NULL')) return [{ locked: true }];
      if (sql.includes('FOR UPDATE')) return [{ id: WALLET, tenantId: VENUE, walletGroup: null, balanceCents: 3_800, status: 'ACTIVE', shortCode: 'K7Q4M2', mergedIntoId: null }];
      return [{ mergedIntoId: null }];
    }),
    walletChargeRequest: { findUnique: vi.fn(async () => charge) },
    venue: { findUnique: vi.fn(async () => ({ name: 'Sala Aurora' })) },
    walletCard: {
      findMany: vi.fn(async () => opts.cards ?? [{ id: 'card-1', venueId: VENUE }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    walletCardEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    clientWallet: { updateMany: vi.fn(async () => ({ count: opts.pinLockable === false ? 0 : 1 })) },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { logInTx: vi.fn(async () => undefined) };
  const svc = new ChargeDisputeService(prisma as never, audit as never, { JWT_SECRET: SECRET });
  return { svc, tx, audit };
}

const tokenFor = (walletId = WALLET, now = Date.now()) => signNotMeToken({ chargeId: CHARGE, walletId }, now, SECRET);

describe('«No he sido yo»', () => {
  it('mirar no cambia nada: enseña el cobro (importe con propina, local, referencia)', async () => {
    const { svc, tx, audit } = harness();
    const view = await svc.view(tokenFor());
    expect(view).toMatchObject({ state: 'ask', ref: 'C-0042', totalCents: 1_200, venueName: 'Sala Aurora' });
    expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
    expect(audit.logInTx).not.toHaveBeenCalled();
  });

  it('confirmar: bloquea sus fichas y su PIN y deja el aviso al local del cobro', async () => {
    const { svc, tx, audit } = harness({ cards: [{ id: 'card-1', venueId: VENUE }, { id: 'card-2', venueId: null }] });
    const out = await svc.dispute(tokenFor());
    expect(out).toMatchObject({ state: 'done', blockedCards: 2, pinLocked: true, ref: 'C-0042' });
    expect(tx.walletCard.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { walletId: WALLET, status: { in: ['ISSUED', 'ACTIVE'] } } }));
    expect(tx.walletCard.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'BLOCKED', blockedAt: expect.any(Date) } }));
    expect(tx.walletCardEvent.createMany).toHaveBeenCalledTimes(2);
    expect(tx.clientWallet.updateMany).toHaveBeenCalledWith({ where: { id: WALLET, pinHash: { not: null }, pinLockedAt: null }, data: { pinLockedAt: expect.any(Date) } });
    expect(audit.logInTx).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: CHARGE_DISPUTED_ACTION,
      tenantId: VENUE,
      actorId: null,
      targetType: 'WalletChargeRequest',
      targetId: CHARGE,
      payload: expect.objectContaining({ ref: 'C-0042', amountCents: 1_200, code: 'K7Q-4M2', cards: 2, pinLocked: true }),
    }));
  });

  it('con el enlace de un cobro no se bloquea otro saldo (firma de otro saldo): nada cambia', async () => {
    const { svc, tx, audit } = harness();
    expect(await svc.dispute(tokenFor(OTHER))).toEqual({ state: 'invalid' });
    expect(await svc.view(tokenFor(OTHER))).toEqual({ state: 'invalid' });
    expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
    expect(tx.clientWallet.updateMany).not.toHaveBeenCalled();
    expect(audit.logInTx).not.toHaveBeenCalled();
  });

  it('caducado, inventado o de un cobro sin pagar: no hace nada', async () => {
    const { svc, tx, audit } = harness();
    expect(await svc.dispute(tokenFor(WALLET, Date.now() - NOT_ME_TTL_MS - 1))).toEqual({ state: 'expired' });
    expect(await svc.dispute('inventado.xxx')).toEqual({ state: 'invalid' });
    const unpaid = harness({ status: 'CANCELED' });
    expect(await unpaid.svc.dispute(tokenFor())).toEqual({ state: 'not-paid' });
    for (const h of [tx, unpaid.tx]) expect(h.walletCard.updateMany).not.toHaveBeenCalled();
    expect(audit.logInTx).not.toHaveBeenCalled();
  });

  it('una sola vez por cobro: la segunda dice «ya nos lo has dicho» y no avisa otra vez', async () => {
    const { svc, tx, audit } = harness({ disputed: true });
    expect(await svc.dispute(tokenFor())).toMatchObject({ state: 'already', ref: 'C-0042' });
    expect(await svc.view(tokenFor())).toMatchObject({ state: 'already' });
    expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
    expect(audit.logInTx).not.toHaveBeenCalled();
  });

  it('sin ficha: bloquea el PIN y avisa igual', async () => {
    const { svc, tx } = harness({ cards: [] });
    expect(await svc.dispute(tokenFor())).toMatchObject({ state: 'done', blockedCards: 0, pinLocked: true });
    expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
  });
});

describe('la página «No he sido yo»', () => {
  const charge = { ref: 'C-0042', totalCents: 1_200, venueName: 'Sala <Aurora>', at: new Date('2026-11-16T22:40:00Z') };

  it('enseña el cobro y un formulario que funciona sin JS (sin datos del cliente)', () => {
    const html = renderNotMePage('/w/no/tok', 'es', { state: 'ask', ...charge });
    expect(html).toContain('¿Has sido tú?');
    expect(html).toContain('Cobro C-0042 · 16/11');
    expect(html).toContain('en Sala &lt;Aurora&gt;');
    expect(html).toContain('<form method="post" action="/w/no/tok?lang=es" enctype="text/plain"');
    expect(html).toContain('No he sido yo');
    expect(html).toContain('Si has sido tú, no tienes que hacer nada.');
    expect(html).not.toContain('<Aurora>');
  });

  it('hecho, ya avisado y enlaces que no valen', () => {
    expect(renderNotMePage('/w/no/t', 'es', { state: 'done', blockedCards: 1, pinLocked: true, ...charge })).toContain('Hemos avisado a recepción del cobro C-0042');
    expect(renderNotMePage('/w/no/t', 'es', { state: 'already', ...charge })).toContain('Recepción ya está revisando este cobro.');
    expect(renderNotMePage('/w/no/t', 'es', { state: 'expired' })).toContain('Este enlace ha caducado');
    const invalid = renderNotMePage('/w/no/t', 'en', { state: 'invalid' });
    expect(invalid).toContain('This link isn’t valid');
    expect(invalid).not.toContain('<form');
  });

  it('lleva el pie legal en su idioma, como las demás páginas del cliente', () => {
    const views: (NotMeView | NotMeResult)[] = [
      { state: 'ask', ...charge },
      { state: 'done', blockedCards: 1, pinLocked: true, ...charge },
      { state: 'already', ...charge },
      { state: 'expired' },
      { state: 'invalid' },
      { state: 'not-paid' },
    ];
    for (const view of views) {
      const html = renderNotMePage('/w/no/t', 'pt', view);
      expect(html).toContain(legalFooter('pt'));
      expect(html).toContain('href="/legal/condiciones?lang=pt"');
      // Debajo del contenido, antes del script, y con su CSS (va en CHROME_CSS).
      expect(html.indexOf('</main>')).toBeLessThan(html.indexOf('class="legal-foot"'));
      expect(html.indexOf('class="legal-foot"')).toBeLessThan(html.indexOf('<script>'));
      expect(html).toContain('.legal-foot{');
    }
  });
});
