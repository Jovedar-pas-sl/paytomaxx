import { describe, it, expect, vi } from 'vitest';
import { ApprovalExpiryService } from './approval-expiry.service';

describe('repaso de solicitudes caducadas', () => {
  it('caduca las de más de 24 h de todos los locales', async () => {
    const requests = { expireStale: vi.fn().mockResolvedValue(3) };
    const svc = new ApprovalExpiryService(requests as never);
    const now = new Date('2026-10-16T05:00:00Z');
    expect(await svc.tick(now)).toBe(3);
    expect(requests.expireStale).toHaveBeenCalledWith(now);
  });

  it('una vuelta lenta no se solapa con la siguiente; un fallo no rompe nada', async () => {
    let release: (n: number) => void = () => undefined;
    const requests = { expireStale: vi.fn(() => new Promise<number>((res) => (release = res))) };
    const svc = new ApprovalExpiryService(requests as never);
    const first = svc.tick();
    expect(await svc.tick()).toBe(0);
    release(1);
    expect(await first).toBe(1);
    requests.expireStale.mockRejectedValueOnce(new Error('base caída'));
    expect(await svc.tick()).toBe(0);
  });

  it('en pruebas no arranca el temporizador', () => {
    const svc = new ApprovalExpiryService({ expireStale: vi.fn() } as never);
    const spy = vi.spyOn(globalThis, 'setInterval');
    svc.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
