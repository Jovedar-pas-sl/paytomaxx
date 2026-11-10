import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Lo mismo que vitest sin configuración, más el alias «@/» de tsconfig.json:
// así una prueba puede pintar un componente que importa '@/lib/...'
// (CobrosTable, CobroRowActions) como lo compila Next.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
