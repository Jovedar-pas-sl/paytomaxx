import { defineConfig } from 'vitest/config';

// El JSX de los componentes se compila aparte (Next): aquí, el automático.
export default defineConfig({ esbuild: { jsx: 'automatic' } });
