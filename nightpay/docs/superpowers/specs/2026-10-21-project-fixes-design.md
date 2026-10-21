# Correcciones de la revisión global

Diseño aprobado en la conversación del 21 de octubre: cuatro bloques, seguridad → dinero → recuperación/despliegue → pantallas/pruebas. El usuario confirmó «vale start» tras la lista concreta de arreglos. Base publicada: `7ba61c1`; rama de ejecución: `fix/project-review-20261021`. El informe `docs/reviews/2026-10-21/REVISION-GLOBAL-MEJORAS.md` aporta reproducciones y fuentes.

## Comportamiento acordado

1. La wallet con passkey exige una sesión de consulta para todas las rutas que revelan saldo, consumos o pase Google. El enlace privado sin passkey mantiene la primera activación existente. El enlace público de ficha no permite activarla. Regenerar el enlace invalida una verificación NFC en curso. Superadmin exige sesión viva y MFA, además del permiso actual y los step-up de escrituras.
2. La intención de dinero se conserva de extremo a extremo: cambiar destino bajo una clave de recarga devuelve 409; reintentar una devolución recupera su resultado; Paytef concilia por terminal y operación, sin elegir referencias ambiguas. El barrido de devoluciones progresa aunque haya fallos persistentes.
3. Una restauración con errores inesperados falla. Las métricas/alertas reflejan colas reales. El commit desplegado se identifica dentro del flujo Git/Dokploy, sin pedir al usuario etiquetas manuales por despliegue.
4. El historial revalida los cobros visibles, el mapa distingue saldo real/variación/periodo y muestra la fecha de sus datos; la carta de referencia se aplica de forma atómica por local; los recorridos esenciales de navegador se ejecutan con datos aislados en CI.

## Límites y compatibilidad

No se cambian comisiones, porcentajes, fiscalidad, permisos comerciales ni importes aprobados. OxioPay sigue pendiente; BBVA desconocido. Se preservan rutas compatibles, recibos, historial, primera activación y decisiones MFA existentes. Las migraciones nuevas serán aditivas y posteriores a las publicadas. No se despliega ni modifica la base real durante el desarrollo.

## Verificación

Cada defecto requiere prueba roja antes del arreglo, prueba verde y regresiones relacionadas. Comprobar roles/locales, repetición/concurrencia y cortes de conexión. El cierre exige lint/tipos, suites afectadas, integración PostgreSQL con rol no superusuario, build/CI y revisión independiente. Commits por bloque; la publicación sigue Git y el despliegue manual del usuario en Dokploy.
