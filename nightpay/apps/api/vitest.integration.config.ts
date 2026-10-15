import { defineConfig } from 'vitest/config';

// Pruebas de integración contra un Postgres de verdad (RLS forzado, con el rol
// dueño de la base y sin superusuario). No las coge `vitest run` (ese solo mira
// src/**/*.spec.ts): se lanzan con `pnpm test:integration`. Ver
// test/integration/README.md.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/integration/**/*.int.spec.ts'],
    setupFiles: ['test/integration/setup.ts'],
    // Comparten la base de datos: un fichero detrás de otro, en un solo proceso.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
