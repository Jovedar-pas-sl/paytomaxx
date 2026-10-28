import { afterAll, describe, expect, it } from 'vitest';
import { initSentry } from './sentry';

// SDK real, sin enviar eventos: comprueba el arranque y el filtro de privacidad.
const sdk = require('@sentry/node') as typeof import('@sentry/node');
afterAll(async () => { await sdk.close(0); });

describe('SDK de observación actualizado', () => {
  it('arranca y conserva la limpieza de datos sensibles', () => {
    initSentry({ SENTRY_DSN: 'https://public@example.invalid/1', NODE_ENV: 'test', GIT_SHA: 'test' });
    const client = sdk.getClient();
    expect(client).toBeDefined();
    const options = client!.getOptions();
    expect(options.sendDefaultPii).toBe(false);
    expect(typeof options.beforeSend).toBe('function');
    expect(typeof options.beforeBreadcrumb).toBe('function');
    const event = options.beforeSend!({ message: 'test', extra: { password: 'clave-ficticia' } } as never, {} as never) as { extra: { password: string } };
    expect(event.extra.password).not.toBe('clave-ficticia');
  });
});
