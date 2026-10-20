'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { fetchOperators, type Operator } from '@/lib/api';
import { Notice } from '../Notice';
import { OperatorDetailModal } from '../OperatorDetailModal';
import { FichasContext, type FichasApi } from './fichas-context';
import { WalletFichaModal } from './WalletFichaModal';

/**
 * Las fichas del saldo y de la chica, abiertas desde cualquier lista del
 * panel (Cobros, Saldos, otra ficha). Una a la vez, encima de lo que haya.
 */
export function FichasProvider({ isOwner, children }: { isOwner: boolean; children: ReactNode }) {
  const [walletId, setWalletId] = useState<string | null>(null);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useMemo<FichasApi>(
    () => ({
      openWallet: (id) => {
        setOperator(null);
        setWalletId(id);
      },
      openOperator: (id) => {
        setError(null);
        // Las chicas y los camareros (los dos tienen ficha: su parte se les paga igual).
        Promise.all([fetchOperators(), fetchOperators('WAITER').catch(() => [] as Operator[])])
          .then(([chicas, camareros]) => {
            const found = [...chicas, ...camareros].find((o) => o.id === id);
            if (!found) {
              setError('Esa persona ya no está en el local.');
              return;
            }
            setWalletId(null);
            setOperator(found);
          })
          .catch((err: Error) => setError(err.message));
      },
    }),
    [],
  );

  return (
    <FichasContext.Provider value={api}>
      {error ? (
        <Notice tone="danger" action={{ label: 'Entendido', onClick: () => setError(null) }}>
          {error}
        </Notice>
      ) : null}
      {children}
      {walletId ? <WalletFichaModal walletId={walletId} onClose={() => setWalletId(null)} /> : null}
      {operator ? (
        <OperatorDetailModal
          operator={operator}
          isOwner={isOwner}
          onClose={() => setOperator(null)}
          onChanged={() => undefined}
        />
      ) : null}
    </FichasContext.Provider>
  );
}
