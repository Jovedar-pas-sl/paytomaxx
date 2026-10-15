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
      // Suelo, no objetivo: un punto por debajo de lo medido el 2026-10-15
      // (líneas 49,5 %, funciones 63,4 %, ramas 78,4 %). Que no baje; al
      // añadir pruebas, súbelo.
      thresholds: {
        lines: 48,
        statements: 48,
        functions: 62,
        branches: 77,
      },
    },
  },
});
