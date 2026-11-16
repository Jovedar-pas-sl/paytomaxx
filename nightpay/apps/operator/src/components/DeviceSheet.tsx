'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Modal, Segmented } from '@nightpay/ui';
import { fichaPlace, READER_SPOT_CHOICES, useReaderSpot, writeReaderSpot } from '@/lib/lector-nfc';
import { nfcSupported, readCard } from '@/lib/nfc';
import { testReadResult, type TestRead as TestReadResult } from '@/lib/prueba-lectura';

/**
 * Menú → «Este aparato»: lo de ESTE móvil o datáfono, guardado en él. Dónde
 * está su lector NFC (cambia dónde se pide acercar la ficha) y una prueba de
 * lectura que no cobra nada. Más adelante, aquí irá la impresora.
 */
export function DeviceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const spot = useReaderSpot();
  return (
    <Modal open={open} onClose={onClose} title="Este aparato">
      <div style={stack}>
        <Segmented label="¿Dónde está el lector NFC?" value={spot} options={READER_SPOT_CHOICES} onChange={writeReaderSpot} />
        <p style={hint}>Un móvil lo lleva detrás; un datáfono de mano suele llevarlo arriba.</p>
        {open ? <ReadTest /> : null}
      </div>
    </Modal>
  );
}

/** «Prueba de lectura»: acerca una ficha y dice «Leída ✓» con su número, sin cobrar nada (por la escucha de la app, nfc-hub). */
function ReadTest() {
  const spot = useReaderSpot();
  const [supported, setSupported] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  const [result, setResult] = useState<TestReadResult | null>(null);
  useEffect(() => setSupported(nfcSupported()), []);
  useEffect(() => () => reading?.abort(), [reading]);

  async function start() {
    const ctrl = new AbortController();
    setReading(ctrl);
    setResult(null);
    try {
      const read = await readCard(ctrl.signal);
      setResult(testReadResult(read));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setResult({ ok: false, text: (err as Error).message });
    } finally {
      setReading((current) => (current === ctrl ? null : current));
    }
  }

  return (
    <section aria-label="Prueba de lectura" style={stack}>
      <span style={label}>Prueba de lectura</span>
      {!supported ? (
        <p style={hint}>Este aparato no lee fichas desde la app: hace falta un Android con Chrome.</p>
      ) : reading ? (
        <Button variant="ghost" onClick={() => reading.abort()}>
          Acerca la ficha {fichaPlace(spot, 'móvil')}… (cancelar)
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => void start()}>
          {result ? 'Probar otra ficha' : 'Probar a leer una ficha'}
        </Button>
      )}
      {result ? (
        <p role="status" style={{ ...resultStyle, color: result.ok ? 'var(--np-text)' : 'var(--np-danger-text)' }}>
          {result.text}
        </p>
      ) : null}
    </section>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const label: CSSProperties = { fontSize: 'var(--np-fs-14)', fontWeight: 600, color: 'var(--np-text)' };
const hint: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };
const resultStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-16)', fontWeight: 600 };
