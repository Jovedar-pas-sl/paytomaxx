// Avisos entre pestañas de la misma app (BroadcastChannel): «salí», «la
// sesión caducó», «entró alguien / cambió el local». Nunca llevan tokens.

export type TabMessage =
  | { readonly type: 'logout' }
  /** `at`: cuándo empezó el refresco que el API rechazó. */
  | { readonly type: 'expired'; readonly at: number }
  /** Quién es ahora la sesión de la app (tras entrar o cambiar de local). */
  | { readonly type: 'session'; readonly id: string; readonly tenantId: string };

/** Lo mínimo de BroadcastChannel que se usa (para poder sustituirlo en las pruebas). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type ChannelFactory = (name: string) => BroadcastChannelLike | null;

/** El de verdad, solo en el navegador. En Node (build de Next) no se abre: dejaría el proceso vivo. */
export const browserChannel: ChannelFactory = (name) => {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(name);
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel;
};

/** Un mensaje de otra pestaña: se comprueba la forma antes de hacer caso. */
export function parseTabMessage(data: unknown): TabMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.type === 'logout') return { type: 'logout' };
  if (m.type === 'expired' && typeof m.at === 'number') return { type: 'expired', at: m.at };
  if (m.type === 'session' && typeof m.id === 'string' && typeof m.tenantId === 'string') {
    return { type: 'session', id: m.id, tenantId: m.tenantId };
  }
  return null;
}

export interface TabChannel {
  post(message: TabMessage): void;
  /** Mensajes de las OTRAS pestañas (BroadcastChannel no se los manda a quien los envía). */
  subscribe(listener: (message: TabMessage) => void): () => void;
}

/** Se abre al primer uso; sin BroadcastChannel, no hace nada. */
export function createTabChannel(name: string, factory: ChannelFactory): TabChannel {
  let channel: BroadcastChannelLike | null | undefined;
  const listeners = new Set<(message: TabMessage) => void>();

  function open(): BroadcastChannelLike | null {
    if (channel !== undefined) return channel;
    try {
      channel = factory(name);
    } catch {
      channel = null;
    }
    channel?.addEventListener('message', (event) => {
      const message = parseTabMessage(event.data);
      if (message) for (const l of [...listeners]) l(message);
    });
    return channel;
  }

  return {
    post(message) {
      try {
        open()?.postMessage(message);
      } catch {
        // Pestaña cerrándose o canal cerrado: las otras se enterarán al refrescar.
      }
    },
    subscribe(listener) {
      open();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
