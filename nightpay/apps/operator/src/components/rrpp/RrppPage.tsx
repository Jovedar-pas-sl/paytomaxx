'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@nightpay/ui';
import type { MyPromoterView } from '@nightpay/contracts';
import { hasSession } from '@/lib/api';
import { fetchMyPromoter } from '@/lib/rrpp';
import { ScreenHeader } from '../cobrar/ScreenHeader';
import cobrarStyles from '../cobrar/cobrar.module.css';
import { NotPromoter, RrppView } from './RrppView';
import styles from './rrpp.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'loggedOut' }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; view: MyPromoterView | null };

/** /rrpp: la página del RRPP, con la sesión de la app del personal. */
export function RrppPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback((signal?: AbortSignal) => {
    if (!hasSession()) {
      setState({ kind: 'loggedOut' });
      return;
    }
    setState({ kind: 'loading' });
    fetchMyPromoter(signal).then(
      (view) => setState({ kind: 'ready', view }),
      (err: Error) => {
        if (!signal?.aborted) setState({ kind: 'error', text: err.message });
      },
    );
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return (
    <main className={`np-screen ${styles.page}`}>
      <div className={cobrarStyles.screen}>
        <ScreenHeader title="Tus reservas de RRPP" subtitle="Tu enlace y tu comisión" onBack={() => window.location.assign('/')} />
        <div className={styles.body}>
          {state.kind === 'loading' ? (
            <p className={styles.note}>Cargando…</p>
          ) : state.kind === 'loggedOut' ? (
            <section className={styles.section}>
              <p className={styles.note}>Para ver tus reservas de RRPP, entra primero en la app del personal.</p>
              <a href="/" className="np-btn" data-variant="primary" data-size="lg">
                Entrar
              </a>
            </section>
          ) : state.kind === 'error' ? (
            <section className={styles.section}>
              <p role="alert" className={styles.error}>
                {state.text}
              </p>
              <Button size="lg" variant="ghost" onClick={() => load()}>
                Reintentar
              </Button>
            </section>
          ) : state.view ? (
            <RrppView view={state.view} />
          ) : (
            <NotPromoter />
          )}
        </div>
      </div>
    </main>
  );
}
