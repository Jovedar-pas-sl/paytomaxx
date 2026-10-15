// Antes de cada fichero de integración: comprobar que hay una base de pruebas.
// Estas pruebas CREAN locales, usuarios y cobros: nunca contra producción.

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'Las pruebas de integración necesitan DATABASE_URL (un Postgres de pruebas con las migraciones aplicadas). ' +
      'Ver apps/api/test/integration/README.md.',
  );
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('NODE_ENV=production: las pruebas de integración escriben datos y no se lanzan contra producción.');
}
// Pruebas: sin alertas de Telegram ni tareas programadas.
process.env.NODE_ENV ??= 'test';
// Clave del servidor para el PIN del saldo (solo pruebas).
process.env.ENCRYPTION_KEK ??= 'clave-del-servidor-para-las-pruebas-0123456789';
