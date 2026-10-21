# Revisión global y mejoras propuestas

Fecha: 21 de octubre de 2026. Referencia: `main / 7ba61c169838eec53ba83127d57d9f13055f4c24`.

## Conclusión

La prioridad es completar la seguridad de los accesos, la fiabilidad de los reintentos de dinero y la recuperación ante fallos. Después, mejorar la lectura y navegación del mapa y consolidar las verificaciones de despliegue. El proyecto ya tiene una base funcional extensa: cobro QR, saldo, fichas, recepción, invitaciones, reparto, aprobaciones, cierres, conciliación, auditoría e incidencias.

Esta revisión es transversal: backend, contratos, esquema, panel, operador, TPV, páginas del cliente, integración PAX, pruebas, scripts y documentación. La profundidad se concentra en dinero, permisos y operación. No es una certificación de todos los endpoints ni de la configuración desplegada. No se ejecutaron pagos, cambios de datos, SSH o despliegues de producción.

## Base que conviene conservar

- Monolito modular, contratos compartidos y dinero en céntimos.
- Transacciones, bloqueos, reservas de devoluciones y registros de auditoría.
- Separación de permisos por rol, puesto y local; RLS y pruebas de integración con un rol sin superusuario.
- Sesiones del personal con cookie de refresco HttpOnly, gestión de expiración y cliente API compartido.
- Cierre de noche con comprobaciones, arqueo y Z congelado.
- Conciliación bancaria por CSV e incidencias orientadas a resolver problemas.
- Alertas Telegram, Sentry con filtrado, health del proceso separado del de dependencias, vigilancia de copias S3 y herramientas de segunda copia/restauración.
- CI con tipos, lint, unitarios, integración PostgreSQL, comprobación de migraciones y construcción/arranque de cinco imágenes.

Lo anterior existe en el código; su presencia no demuestra que todas sus opciones estén configuradas en el VPS.

## 1. Seguridad y recuperación: antes de ampliar funciones

### A1 · P1 · Unificar la autorización de consulta del saldo

**Confirmado mediante prueba HTTP local.** La nueva protección de `/w/:token/state` devuelve 401 sin cookie, pero `GET /v1/wallets/public/:qrToken` devuelve saldo y consumos para el mismo token. El endpoint de Google Wallet tampoco exige esa consulta desbloqueada; si está habilitado permite pedir el pase, que muestra el saldo.

Fuentes: `apps/api/src/modules/wallets/wallets.controller.ts:54`, `wallets.service.ts:368`, `google-wallet/google-wallet.controller.ts:36` y la nueva protección de `public-wallet.controller.ts`.

**Mejora:** compartir una autorización de lectura para todas las vías; retirar o proteger rutas de compatibilidad tras comprobar sus consumidores. Cubrir mediante HTTP la wallet con/sin passkey, sesión vencida, enlace regenerado y cada alternativa pública.

### A2 · P1 · Exigir autenticación privilegiada vigente para superadmin

**Confirmado en código y reproducción del guard.** `SuperAdminGuard` comprueba el flag actual y la baja del usuario, pero admite un payload sin `sid` y no comprueba que la sesión haya pasado MFA. Un JWT de OWNER previo a su promoción puede entrar en lecturas globales al activarse el flag. La verificación global del JWT no consulta la sesión viva. Las escrituras sensibles sí conservan step-up TOTP; este hallazgo no implica que puedan ejecutarse sin ese segundo factor.

Fuentes: `apps/api/src/modules/superadmin/superadmin.guard.ts:40`, `staff.service.ts:322`, `apps/api/src/common/guards/staff-token.ts:13`, `packages/contracts/src/auth.ts:88`.

**Mejora:** vincular el acceso privilegiado a sesión viva, usuario y prueba de MFA; exigir reautenticación tras una promoción o recuperación. Probar revocación, promoción, baja y reset de MFA. Evitar extender a usuarios ordinarios una política nueva sin definir primero su efecto en dispositivos y sesiones.

### A3 · P1 · Hacer fiable el resultado de la prueba de restauración

**Defecto del guion comprobado por inspección; no se ha restaurado una copia real en esta revisión.** En formato custom, `restore-check.sh` absorbe cualquier error de `pg_restore` y después comprueba principalmente filas en tres tablas y datos de migraciones. Una restauración parcial puede cumplir esas comprobaciones y anunciar OK aunque falten otras tablas, restricciones o datos.

Fuente: `scripts/restore-check.sh:83` y comprobaciones finales.

**Mejora:** fallar ante errores de restauración inesperados; tratar de forma explícita cualquier excepción conocida. Comprobar esquema, restricciones, migraciones, coherencia mínima de saldos y uso del rol aplicativo. Registrar fecha y resultado del ensayo de restauración. La copia que el usuario confirmó hoy no se ha vuelto a tocar.

### A4 · P2 · Invalidar consultas NFC en curso al regenerar el enlace

**Reproducción determinista local.** La segunda lectura de `WalletCardViewService.unlock` comprueba ficha y wallet, pero no la continuidad del `qrToken`. Si el dueño lo regenera entre verificación y lectura final, se devuelve el enlace nuevo a una confirmación hecha con la llave anterior.

Fuente: `apps/api/src/modules/wallets/wallet-card-view.service.ts:40`.

**Mejora:** comprobar también la versión del acceso antes de entregar el enlace y emitir cookie. Añadir la carrera de regeneración a las pruebas existentes de bloqueo/reasignación.

## 2. Dinero: exactitud e intención de cada operación

### B1 · P2 · Conciliar Paytef usando terminal y operación

**Bug reproducido con la función real.** Dos terminales pueden compartir número de operación, pero el emparejamiento se indexa por referencia y `loadPaytef` descarta el terminal. Con ventas de 20 € y 30 €, ambas operación 77, un extracto con orden distinto produce incidencias falsas y puede atribuir una fila al local equivocado, aunque los totales sean 50 € en ambos lados.

Fuentes: `apps/api/src/modules/bank-recon/bank-recon.service.ts:425`, `bank-match.ts:141`, `packages/db/prisma/schema.prisma:449`.

**Mejora:** conservar la identidad del terminal y resolver referencias dentro de ese ámbito; rechazar coincidencias ambiguas. Probar múltiples terminales, locales, referencias repetidas y orden distinto del CSV.

### B2 · P2 · Comparar el destino al repetir una recarga en efectivo

**Bug reproducido ejecutando el método real.** `CashTopUpService.replay` comprueba cajero e importe, pero no el saldo solicitado. Una petición al saldo B con la clave de una recarga al saldo A devuelve éxito y los datos de A. No supone una segunda entrada de dinero, pero incumple la validación del reintento y puede inducir a creer que se recargó el saldo solicitado.

Fuente: `apps/api/src/modules/wallets/wallet-cash-topup.service.ts:403`.

**Mejora:** guardar/comparar una huella de la intención original, incluido destino y creación frente a saldo existente; devolver 409 ante un cambio y conservar el recibo original para reintentos idénticos. Considerar explícitamente wallets fusionadas para que un reintento legítimo siga funcionando.

### B3 · Alta · Extender la idempotencia a la devolución solicitada por el navegador

**Riesgo del flujo; no se ha observado ni ejecutado una doble devolución real.** Cada POST crea un `refund.id` nuevo. La idempotencia bancaria protege ese ID, no la intención inicial del trabajador. Una devolución parcial completada cuya respuesta se pierda puede repetirse como otra operación si aún queda importe disponible.

Fuentes: `apps/admin/src/lib/endpoints/payments.ts:109`, `apps/api/src/modules/refunds/refunds.controller.ts:79`, `refunds.service.ts:291`.

**Mejora:** clave estable por intención de devolución desde la pantalla hasta el servidor, recuperación del resultado y rechazo de cambios de importe/cobro bajo la misma clave. Mantener las reservas y aprobaciones actuales. Distinguir un reintento de dos devoluciones parciales deliberadas.

### B4 · Media · Evitar que el primer lote de errores bloquee las recuperaciones posteriores

**Riesgo comprobado en el algoritmo.** El barrido de descuentos por devoluciones vuelve a seleccionar siempre los 100 registros pendientes más antiguos. Cien errores persistentes pueden dejar sin intento los registros siguientes.

Fuente: `apps/api/src/modules/refunds/refund-reversal-sweep.service.ts:78`.

**Mejora:** fecha de próximo intento, espera creciente, recorrido de lotes y alerta por antigüedad. Registrar un motivo visible para intervención cuando una operación no pueda recuperarse automáticamente.

### B5 · Decisión de negocio pendiente: comisiones

La regla nueva de OxioPay sigue pendiente por indicación del usuario; el coste BBVA se desconoce. Mantener esos estados explícitos y distinguir el cálculo existente de una regla comercial aprobada. Cuando se decida la regla, definir base, porcentaje, pagador, propinas, recargas, devoluciones y vigencia. Conservar los repartos históricos ya registrados.

## 3. Mapa, carta y experiencia del personal

### C1 · Alta · Dar un significado único a las cifras del mapa

**Incoherencia de presentación comprobada.** La leyenda principal llama «Saldo vivo» a `where.owners.saldoCents`, que el backend calcula como variación del periodo. El saldo real es `where.liveSaldoCents`. Pueden ser distintos e incluso tener signos diferentes. Además, una nota utiliza «ahora» al mostrar importes conservados en un Z.

Fuentes: `apps/admin/src/lib/money-map-view.ts:138,205`, `apps/api/src/modules/money-map/money-map-rules.ts:131`, `packages/contracts/src/money-map.ts:90`.

**Mejoras concretas, conservando las barras A:**

- Nombrar «Variación del saldo del periodo» y «Saldo real de clientes» por separado.
- Distinguir ventas brutas, devoluciones, recargas, pendientes y pagos realizados.
- Mostrar `generatedAt` como hora de los datos; el reloj del móvil no indica que se haya completado un refresco.
- Mostrar fecha y condición de corte/congelación del Z.
- Añadir selector de fechas: el endpoint y el cliente API ya admiten `from/to`.
- Abrir desde una sección o importe la lista de cobros filtrada que lo explica.
- Conservar signos, desconocidos y explicaciones de los costes; evitar presentar la parte del local como beneficio neto o como efectivo disponible.

### C2 · P2 · Actualizar todos los cobros visibles del historial

El sondeo de `MyCobros.tsx:21` consulta solo los primeros 50 y conserva las páginas anteriores. Tras «Ver anteriores», una devolución/anulación de una fila antigua no se refleja hasta remontar la pantalla. Revalidar las páginas cargadas o los registros visibles y probar el caso con más de 50 movimientos.

### C3 · Media · Aplicar la carta de referencia como una sola operación

`CartaTemplate.tsx:31` consulta el catálogo y luego crea/actualiza producto por producto. La recuperación parcial está explicada y funciona como intención de diseño. Mejoraría la aplicación para que dos administradores no puedan preparar el mismo plan y crear duplicados simultáneamente: prevalidación, transacción, exclusión por local y resultado repetible. Es una propuesta a partir del flujo, no una carrera contra producción observada.

### C4 · Media · Guiar la activación y recuperación del cliente

Mostrar con claridad ficha preparada/asignada, saldo cargado y desbloqueo activado. Dar al personal un recorrido de entrega y recuperación del enlace privado que conserve las comprobaciones de identidad, permisos y auditoría. No autorizar movimientos por conocer el número impreso o por presentar solo el enlace público de una ficha.

Mantener la diferencia en el lenguaje de las pantallas entre «pagar con saldo acercando la ficha» y «pagar con tarjeta bancaria». Unificar el nombre visible de producto donde conviven OxioCard/OxioPay; el nombre interno NightPay no requiere por sí mismo una migración.

## 4. Operación, pruebas y despliegue

### D1 · Alta · Probar las alertas con datos reales de su fuente

`MetricsService.queueDepth` está declarado sin un productor que lo actualice. La alerta de backlog queda sin una medida útil. `HighErrorRate` divide series etiquetadas por `from/to` entre series por `venue/provider`, sin agregación compatible, por lo que la expresión no empareja las series previstas.

Fuentes: `apps/api/src/modules/metrics/metrics.service.ts:15,147`, `docs/observability/alerts.yml:19,75`.

**Mejora:** alimentar la cola y la antigüedad del trabajo más viejo, corregir las agregaciones y comprobar que una incidencia sintética dispara y se resuelve. Integrarlo con las herramientas existentes. No se ha confirmado que estas reglas Prometheus estén cargadas en producción; Incidencias y Telegram tienen mecanismos independientes.

### D2 · Alta · Pruebas de navegador estables en CI

Actualmente Playwright requiere servicios y datos manuales y no forma parte del workflow. Sus pruebas de panel simulan el refresco de sesión, de modo que no validan el login/cookie reales. CI sí comprueba la construcción, arranque, tipos y flujos de API; son garantías distintas.

Fuentes: `apps/e2e/README.md`, `apps/e2e/playwright.config.ts`, `apps/e2e/tests/admin-ui.spec.ts`, `.github/workflows/nightpay-ci.yml`.

**Mejora:** un conjunto pequeño con datos aislados y servicios levantados automáticamente: login y permisos; carta y total; cobro/confirmación; saldo y desbloqueo con autenticador virtual; devolución con respuesta perdida; cierre y navegación. Guardar capturas/trazas al fallar. Separar estas pruebas de la comprobación física con teléfonos, fichas y, cuando corresponda, PAX reales.

### D3 · Media · Identificar automáticamente lo desplegado

El health devuelve un marcador fijo si faltan variables de versión. Eso hace difícil asegurar que API y webs corresponden al commit elegido al pulsar Deploy.

Fuentes: `apps/api/src/modules/health/health.controller.ts:86`, `apps/api/Dockerfile:49`.

**Mejora:** integrar automáticamente la identificación del commit en el flujo Git → Deploy de Dokploy y mostrarla en API/panel. Registrar una comprobación posterior al despliegue: versión, health, login, carta, saldo y permisos; conservar el punto de vuelta compatible con migraciones.

### D4 · Comprobación operativa: completar el aislamiento estricto

El middleware permite `TENANCY_UNSCOPED_QUERIES=log` por defecto; ya existe el modo `throw`. Verificar el rol y la variable reales en Dokploy, observar las consultas legítimas del sistema y completar el paso documentado a modo estricto con prueba de dos locales. No se afirma que producción use superusuario ni que esté hoy en modo `log`.

Fuente: `apps/api/src/common/prisma/prisma.service.ts:204`, `docs/DB-ROLE.md`.

### D5 · Confirmación por entorno de las integraciones

Redsys/BBVA es la integración efectiva recuperada en las notas actuales. Tener código de Peanpe, Paytef y PAX no demuestra que estén activados ni validados con credenciales/dispositivos reales. Mantener una tabla de capacidad por entorno: implementado, probado localmente, validado con proveedor y activo en producción. El foco Android actual no exige reactivar PAX.

## 5. Mantenimiento y continuidad entre sesiones

### E1 · Actualizar los documentos que se usan para operar

`POST_LAUNCH.md` contiene pendientes ya resueltos y notas contradictorias; `HARDENING.md` conserva instrucciones antiguas; el onboarding habla de una cuenta OWNER global y de pantallas/proveedores que no describen el modelo vigente; `PUESTA-EN-MARCHA.md` contiene un comando de publicación de una rama antigua y un recorrido de saldo ya sustituido.

**Mejora:** una entrada vigente de estado y operación, enlaces a las guías actuales, fecha/commit del ensayo y documentos antiguos marcados como históricos. Mantener un registro breve de cambios revisados, comprobaciones y cuestiones pendientes para retomar una sesión sin adivinar entre worktrees y ramas.

### E2 · Alinear herramientas locales y CI

Algunos `package.json` usan `lint ... || true`; el lint raíz de CI sí es estricto. El bootstrap sigue admitiendo Node 20 y absorbe errores de migración, mientras el repositorio exige Node >=22. La configuración E2E también conserva comentarios de puertos antiguos.

**Mejora:** un comando de verificación local que falle si algo falla, versiones/puertos coherentes y bootstrap repetible que no anuncie éxito tras un error de migración.

### E3 · Reducir el coste de cambiar pagos y wallets

Los servicios de pagos y wallets reúnen más de dos mil líneas cada uno, aunque ya se han extraído varias reglas y operaciones. Seguir separando por responsabilidad (intentos/confirmación, devoluciones, fichas, recuperación) mediante cambios pequeños y con las pruebas existentes. Esta es una mejora de mantenimiento, no evidencia por sí sola de un fallo de rendimiento.

## Orden recomendado y criterios de cierre

| Orden | Paquete | Resultado verificable |
|---|---|---|
| 1 | Acceso y recuperación: A1–A4 | Todas las vías de consulta exigen lo previsto; privilegios y recuperación invalidan el acceso anterior; una restauración fallida nunca anuncia OK. |
| 2 | Dinero y conciliación: B1–B4 | Una intención se procesa una vez; un cambio de destino se rechaza; varias operaciones 77 en terminales distintos concilian correctamente; los fallos antiguos no bloquean los nuevos. |
| 3 | Mapa e historial: C1–C2 | Cada cifra tiene periodo/origen claro, se ve su fecha real y los cobros antiguos actualizan su estado. |
| 4 | Carta, entrega y cierres de operación: C3–C4, D3–D5 | Configuración repetible, entrega entendible, versión desplegada identificable y capacidades del entorno documentadas. |
| 5 | Automatización y mantenimiento: D1–D2, E1–E3 | Alertas demostradas, recorridos de navegador reproducibles y una guía actual para operar y continuar el trabajo. |

La decisión comercial de B5 sigue pendiente del usuario. No se propone inventar porcentajes, costes bancarios ni reglas fiscales.

## Comprobaciones realizadas

- CI remoto de `7ba61c1`: cinco trabajos aprobados; SHA confirmado contra GitHub.
- Revisión previa: 66 pruebas seleccionadas de API, administración y operador aprobadas.
- Revisión global: 534 pruebas de autenticación, superadmin, devoluciones, mapa, noches, conciliación y copias aprobadas.
- Cinco reproducciones locales: rutas alternativas de consulta, regeneración NFC durante verificación, colisión de operaciones Paytef, destino distinto en reintento de recarga y guard superadmin sin contexto de sesión/MFA. Afirman el comportamiento problemático para demostrarlo; no son correcciones.
- Las reproducciones están aisladas en `apps/api/.verification/`. El código de producto no se ha modificado. Solo se añade este informe a la copia de revisión.

La configuración real de Dokploy, la restauración de una copia real, las alertas recibidas y las pruebas físicas quedan como comprobaciones operativas; no se han dado por aprobadas por la existencia de código o documentación.
