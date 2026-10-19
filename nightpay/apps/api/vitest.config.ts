import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Solo las unitarias. Las de integración (Postgres real) van aparte:
    // vitest.integration.config.ts / `pnpm test:integration`.
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts'],
      // Suelo, no objetivo: unos dos puntos por debajo de lo medido el
      // 2026-10-20 (líneas y sentencias 85,3 %, funciones 84,2 %, ramas
      // 89,5 %; margen por la diferencia entre máquinas). Que no baje; al
      // añadir pruebas, súbelo.
      thresholds: {
        lines: 83,
        statements: 83,
        functions: 81,
        branches: 87,
      },
    },
  },
});
