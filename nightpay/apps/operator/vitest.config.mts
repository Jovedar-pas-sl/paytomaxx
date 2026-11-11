import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Lo mismo que vitest sin configuración, más el alias «@/» de tsconfig.json y el
// JSX automático (como lo compila Next): una prueba puede pintar un componente
// (la loseta de la carta) con react-dom/server.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
