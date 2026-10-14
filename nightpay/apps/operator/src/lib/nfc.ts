/**
 * Pulsera o tarjeta NFC del cliente (Web NFC). Solo en Android con Chrome: en
 * iPhone el navegador no deja leer NFC, y la pulsera lleva también su código.
 */

interface NdefReadingEvent extends Event {
  serialNumber: string;
}

interface NdefReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: ((event: Event) => void) | null;
}

type NdefReaderCtor = new () => NdefReaderLike;

function readerCtor(): NdefReaderCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { NDEFReader?: NdefReaderCtor }).NDEFReader;
  return typeof ctor === 'function' ? ctor : null;
}

/** ¿Este móvil lee pulseras NFC? */
export function nfcAvailable(): boolean {
  return readerCtor() !== null;
}

/** Espera a que acerquen una pulsera y devuelve su número de serie. */
export async function readNfcTag(signal: AbortSignal): Promise<string> {
  const Reader = readerCtor();
  if (!Reader) throw new Error('Este móvil no lee pulseras NFC: teclea el código');
  const reader = new Reader();
  await reader.scan({ signal });
  return new Promise<string>((resolve, reject) => {
    reader.onreading = (event) => {
      if (event.serialNumber) resolve(event.serialNumber);
      else reject(new Error('No se ha podido leer la pulsera: acércala otra vez'));
    };
    reader.onreadingerror = () => reject(new Error('No se ha podido leer la pulsera: acércala otra vez'));
    signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')));
  });
}
