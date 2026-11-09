'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import type { CustomerSearchResult } from '@nightpay/contracts';
import { searchSaCustomers } from '@/lib/endpoints/superadmin';
import { FILTER_FIELD } from '@/lib/filter-field';
import { formatEur } from '@/lib/money';
import { walletStatus } from '@/lib/superadmin/labels';
import { Notice } from '../Notice';
import { Pill } from '../Pill';
import { CustomerDetailView } from './CustomerDetail';
import { ErrorLine, SectionHead } from './ui';

const MATCHED_BY: Readonly<Record<CustomerSearchResult['matchedBy'], string>> = {
  shortCode: 'por su código',
  cardToken: 'por la ficha NFC',
  cardUid: 'por el nº de serie de la ficha',
  walletId: 'por el id del saldo',
  paymentId: 'por el id de una recarga',
};

const MIN_QUERY = 3;

/**
 * Clientes con saldo de todos los locales: una sola caja de búsqueda
 * (código, ficha NFC, id del saldo o id de un cobro) y la ficha del saldo.
 */
export function CustomersSection() {
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ q: string; items: CustomerSearchResult[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function search(e: FormEvent): Promise<void> {
    e.preventDefault();
    const text = q.trim();
    if (text.length < MIN_QUERY) return setError(`Escribe al menos ${MIN_QUERY} letras o números.`);
    setError(null);
    setSearching(true);
    try {
      const items = await searchSaCustomers(text);
      setResults({ q: text, items });
      // Uno solo: directamente a su ficha.
      setOpenId(items.length === 1 && items[0] ? items[0].walletId : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Todos los locales"
        title="Clientes con saldo"
        sub="Busca por el código del cliente (K7Q-4M2), la ficha NFC, el id del saldo o el id de una recarga."
      />
      <form className="np-sa-search" role="search" onSubmit={(e) => void search(e)}>
        <Input
          label="Buscar saldo"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="K7Q-4M2, ficha o id"
          autoComplete="off"
          spellCheck={false}
          // Campo del panel de 40 px, a la altura del botón (44 en el móvil).
          style={{ ...FILTER_FIELD, height: 'max(2.5rem, var(--np-filter-h))', fontSize: '1rem' }}
        />
        <Button type="submit" loading={searching}>
          Buscar
        </Button>
      </form>
      {error ? <ErrorLine>{error}</ErrorLine> : null}

      {openId ? (
        <CustomerDetailView
          walletId={openId}
          onOpenWallet={setOpenId}
          onBack={results && results.items.length > 1 ? () => setOpenId(null) : undefined}
        />
      ) : results ? (
        results.items.length === 0 ? (
          <Notice tone="info">Ningún saldo con «{results.q}».</Notice>
        ) : (
          <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="np-sa-scroll-x">
              <table className="np-table">
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Saldo</th>
                    <th>Estado</th>
                    <th>Local de origen</th>
                    <th>Encontrado</th>
                  </tr>
                </thead>
                <tbody>
                  {results.items.map((r) => {
                    const status = walletStatus(r.status);
                    return (
                      <tr key={r.walletId} className="np-row-link" onClick={() => setOpenId(r.walletId)}>
                        <td data-label="Código" data-card="title">
                          <button type="button" className="np-sa-link" onClick={() => setOpenId(r.walletId)}>
                            {r.code ?? 'Sin código'}
                          </button>
                        </td>
                        <td data-label="Saldo" data-card="amount" className="np-num">
                          {formatEur(r.balanceCents)}
                        </td>
                        <td data-label="Estado" data-card="status">
                          <span className="np-sa-btn-row">
                            <Pill tone={status.tone}>{status.label}</Pill>
                            {r.blocked ? <Pill tone="danger">Bloqueado</Pill> : null}
                          </span>
                        </td>
                        <td data-label="Local de origen">{r.homeVenue.name}</td>
                        <td data-label="Encontrado">{MATCHED_BY[r.matchedBy]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )
      ) : null}
    </div>
  );
}
