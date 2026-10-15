// Arranque en local (`pnpm dev`): NODE_ENV=development explícito. Sin
// NODE_ENV el API se considera producción (lo seguro) — ver config/env.ts.
// En Docker se arranca src/main.ts directamente con NODE_ENV=production.
process.env.NODE_ENV ||= 'development';

// require (no import): así lo de arriba corre antes que main.ts y sus imports.
require('./main');
