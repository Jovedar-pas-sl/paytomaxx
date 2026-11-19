// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandSplash } from './BrandSplash';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('BrandSplash: el símbolo al abrir', () => {
  afterEach(() => vi.useRealTimers());

  it('sale al montar, pasa a «listo» y desaparece solo (no se queda tapando)', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<BrandSplash src="/icons/icon-512.png" />));
    const splash = host.querySelector('.np-splash');
    expect(splash?.getAttribute('aria-hidden')).toBe('true');
    expect(splash?.hasAttribute('data-ready')).toBe(true);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/icons/icon-512.png');
    act(() => void vi.advanceTimersByTime(250));
    expect(host.querySelector('.np-splash')).toBeNull();
    act(() => root.unmount());
  });
});
