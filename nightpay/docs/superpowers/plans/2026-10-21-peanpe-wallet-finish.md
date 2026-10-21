# Terminar recepción y fichas NFC

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement this plan task-by-task.

**Goal:** Terminar las dos decisiones aprobadas en la conversación «Peanpe wallet para cobros card y peanpe», conservando las maquetas A aprobadas.

**Architecture:** Extender la recepción y el ciclo de fichas existentes. Conservar los endpoints antiguos y el número interno automático; guardar aparte el número impreso. Las salidas en efectivo requieren el NFC y el PIN del cliente; una salida que necesita encargado queda pendiente, sin sacar dinero hasta su confirmación por la ruta existente y su 2FA.

**Tech Stack:** NestJS/Fastify, Prisma/Postgres, Next.js/React, Vitest.

## Alcance recuperado

- Base: `feat/integ-ola3`, `1876bbf`, 21 de octubre de 2026.
- Especificación visual: maquetas A de la conversación de Claude; mantener los flujos y la marca OxioCard.
- Decisiones aprobadas: recepción devuelve efectivo con NFC + PIN; desde el umbral se necesita encargado y 2FA; el identificador físico es el número impreso de fábrica, introducido al preparar la ficha y buscable en el panel.
- Android es el dispositivo objetivo. PAX permanece disponible pero no se reactiva.
- La comisión OxioPay y el coste BBVA quedan pendientes por indicación del usuario. No modificar su cálculo. No cambiar IVA, paquetes ni lockfile.

## 1. Base verificable

- [x] Crear rama aislada `codex/peanpe-wallet-finish` desde `1876bbf`.
- [x] Instalar dependencias desde caché con el lockfile congelado y generar Prisma.
- [x] Ejecutar la base de pruebas de fichas, saldos y recepción: 69 pruebas correctas.
- [x] Repetir los checks completos después de los cambios. Los builds anteriores fallaban al crear symlinks de standalone en Windows; distinguir ese fallo de un fallo de compilación.

## 2. Número impreso de la ficha

Archivos: `packages/contracts/src/wallet-card.ts`, `reception.ts`, `packages/db/prisma/schema.prisma` y nueva migración; servicio/controlador de fichas; `PrepareFichas.tsx`, helpers de recepción y panel de fichas.

- [x] Escribir pruebas que fallen: conservar `0522`; rechazar número vacío/no numérico; no etiquetar fichas entregadas, ajenas, bloqueadas ni un UID distinto; duplicados no modifican nada; búsqueda por el número impreso.
- [x] Añadir `printedNumber` opcional, único, con ceros iniciales conservados; no cambiar `number` ni migraciones existentes.
- [x] Registrar el número en una transacción con la ficha bloqueada, permisos del puesto, NFC habilitado y auditoría.
- [x] Al preparar una ficha sin número impreso, pedirlo antes de contarla y continuar; al acercar una ya preparada, conservarlo.
- [x] Mostrarlo y permitir buscarlo en recepción y panel, con compatibilidad para fichas antiguas.
- [x] Pasar pruebas y types de los módulos afectados; cubrir unicidad con Postgres de pruebas.

## 3. Salida de recepción con NFC + PIN

Archivos: nuevo controlador de salida de recepción, `wallet-charges.service.ts`, helper probado para el resultado, `ReceptionDesk.tsx` y `DeskSteps.tsx`.

- [x] Escribir pruebas que fallen para recepción con 50 € en efectivo y sin móvil del cliente, PIN incorrecto, NFC de otro saldo, puesto Barra, importe cambiado y doble petición.
- [x] Mantener el endpoint administrativo de devolución y sus permisos actuales.
- [x] Añadir una ruta de recepción que compruebe puesto/efectivo, NFC original del saldo, PIN con contador existente y cantidad actual bajo bloqueo. Nunca devolver en efectivo la parte cargada con tarjeta.
- [x] Por debajo del umbral, registrar una única devolución y devolver el NFC al stock si el saldo queda a cero.
- [x] Si se requiere encargado, registrar la solicitud de salida y mostrar claramente que no se ha devuelto dinero. La confirmación usa el endpoint administrativo existente y su 2FA; no aceptar el código 2FA de otra persona en la sesión de recepción.
- [x] En la UI, conservar el NFC leído en Salida y pedir el PIN; sin NFC, explicar cómo continuar sin habilitar una devolución por código solo.
- [x] Probar saldos mixtos, fallos de PIN, aislamiento entre locales y carreras con Postgres real.

## 4. Integración y entrega

- [x] Registrar los nuevos controladores sin tocar las copias de trabajo de Claude.
- [x] Ejecutar unitarias, integración, types, lint, Prisma drift y builds pertinentes; registrar resultados nuevos y limitaciones.
- [x] Revisar el diff y documentar el recorrido de recepción.
- [x] Entregar la rama y el resultado verificable. El despliegue queda como paso posterior al resultado revisable; no ejecutar cobros reales.

## Resultado de verificación: 21 de octubre de 2026

| Comprobación | Resultado |
| --- | --- |
| API, suite completa con cobertura | 2.994 correctas, 4 omitidas existentes; 246 archivos correctos |
| Cobertura API | Líneas y sentencias 85,91 %; ramas 89,73 %; funciones 83,19 %; supera los mínimos configurados |
| Integración completa, PostgreSQL real sin superusuario | 304 correctas, 36 archivos |
| Operador | 320 correctas, 40 archivos |
| Administración | 361 correctas, 39 archivos |
| Tipos del monorepo | 13 tareas correctas; API recalculada tras los últimos cambios |
| Lint raíz estricto | Correcto, sin avisos |
| Migraciones | 66 aplicadas a una base nueva; las dos nuevas repetidas sin error |
| Drift tras repetir las migraciones | Correcto; 16 diferencias ya permitidas por la lista existente |
| Build API | Correcto |
| Builds operador y administración | Compilación, tipos y páginas generadas correctos; empaquetado standalone falla con EPERM al crear symlinks en Windows |
| Revisión independiente | Aprobada después de corregir orden de bloqueos y umbral 2FA |
| Diff | Sin errores de espacios; sin cambios de dependencias ni lockfile |

Las regresiones cubren ceros iniciales, unicidad y validación SQL del número,
restricciones de roles y payloads, PIN y bloqueo, importe cambiado, saldo mixto,
aislamiento, umbral local superior a 100 €, y reintentos con recibo estable.
Las carreras de asignación/salida y de dos saldos con la misma clave se prueban
con barreras deterministas en PostgreSQL, comprobando también el rollback.

Los checks de builds se han ejecutado y sus limitaciones se registran arriba;
no se da por verificado el empaquetado de producción. Sigue pendiente la prueba
visual y con NFC físico en Android. El navegador integrado no estaba disponible.
El PostgreSQL temporal se ha detenido al acabar las integraciones.

La continuidad funcional y las decisiones pendientes están en
[REANUDACION-CODEX-2026-10-21.md](../../REANUDACION-CODEX-2026-10-21.md).
