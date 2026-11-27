# Salida de la API de socios: el piloto de los cajeros

Lo que tiene que ser verdad antes de poner `PARTNER_API_ENABLED=true` para un
local, cómo se enciende, la primera semana y cómo se vuelve atrás.

- **Quién**: OxioPay, con el «sí» por escrito del dueño, después de desplegar
  el PR 8 B (guías, referencia, comprobación de la demo y esta lista).
  **Nunca un agente**: ni monta la demo, ni enciende, ni comprueba lo legal.
- **El contrato** está en [`partner-api/pilot/`](../partner-api/pilot/) y las
  guías en [`partner-api/guides/`](../partner-api/guides/es/00-indice.md).
  «Pregunta N» es la de `preguntas.md` del encargo.
- **Pendiente del sí del dueño**: las preguntas aún sin respuesta están
  decididas por su recomendación (abajo, «Decisiones pendientes»). Hasta su sí
  por escrito, la puerta 3 sigue cerrada.

---

## Puerta: todo esto, antes de encender para un local

- [ ] **1. Revisión de seguridad final** sin ningún CRITICAL ni HIGH, sobre
  `main` con el PR 3 B y el PR 8 B fusionados (el §5 del encargo 8 B: los §5
  de los encargos 1, 2, 3 A, 3 B y 8 A punto por punto, cada uno con su
  prueba; en `live` el API no arranca sin `ORIGIN_AUTH_SECRET`;
  `X-Forwarded-For` y `CF-Connecting-IP` falsos por detrás de Cloudflare y
  Traefik; con Redis caído, `503 try_later`; nada delicado en la
  documentación ni en los artefactos).
  *Se comprueba*: el informe de la revisión, con la fecha y el commit de `main`.
- [ ] **2. El PR 3 B fusionado y desplegado en producción**, con la API aún
  apagada: el efectivo de los cajeros fuera del cajón de recepción y en su
  línea «Caja · {socio}» del cierre, en el mapa del dinero y en el CSV.
  *Se comprueba*: `/v1/health` enseña ese commit y, después, una noche cerrada
  sin cambios en el arqueo de recepción.
- [ ] **3. Las respuestas del dueño, por escrito**, a las preguntas abiertas
  (vale «como recomiendas»). Bloquean encender: la 1 (direcciones), la 2, la 4,
  la 5, la 7, la 8 y la 13. Si una respuesta cambia algo ya programado
  (preguntas 9 a 12, 14 o 15), ese cambio se fusiona y se despliega antes.
  *Se comprueba*: el correo o documento del dueño, guardado con la fecha.
- [ ] **4. Dokploy conectado a la organización de GitHub del repositorio**
  (`Jovedar-pas-sl/paytomaxx`):
  - la Fase A de [`DOKPLOY-STEPS.md`](../DOKPLOY-STEPS.md), hecha otra vez con
    esa organización;
  - `nightpay-api`, `nightpay-admin`, `nightpay-operator` y los servicios de
    la demo, apuntando a ese repositorio, rama `main`;
  - un **Deploy** a mano de `main`.
  *Se comprueba*: `/v1/health` enseña el commit de `main` («Qué versión corre», D.1).
- [ ] **5. El correo (Resend) en producción**: `RESEND_API_KEY` y `EMAIL_FROM`
  en `nightpay-api` (D.2). Sin correo, no se enciende.
  *Se comprueba*: un correo de prueba llega a una dirección de OxioPay y, con
  la API encendida, «Conectar una plataforma» ofrece el enlace por correo
  (`emailEnabled: true`).
- [ ] **6. `ORIGIN_AUTH_SECRET` puesto** en `nightpay-api` (en `live` el
  arranque ya lo exige) y su regla de Cloudflare (Fase F).
  *Se comprueba*: una petición al API sin la cabecera de origen recibe `403`.
- [ ] **7. Lo legal del piloto, cerrado por el dueño por escrito**: contrato de
  socio y contrato de datos firmados con la empresa de los cajeros, y
  condiciones y privacidad al día (van en su propio PR).
  *Se comprueba*: el dueño lo confirma por escrito. El agente no lo escribe ni
  lo comprueba.
- [ ] **8. La demo de la Fase H**, solo con datos inventados y sin BTCPay
  (confirmado por escrito). Los cajeros pasaron todas las pruebas del capítulo
  7 y su lista del capítulo 8, con hasta 10 IP fijas en su conexión de la demo.
  *Se comprueba*: el flujo `partner-demo` en verde en `main`; desde otra
  máquina, con `CF-Connecting-IP` y `X-Forwarded-For` inventados con una de
  esas IP, la demo responde `403 ip_not_allowed`.
- [ ] **9. Las consultas A y B, leídas** (abajo): el dueño recibe solo los
  totales y decide por escrito. El local piloto es peninsular, con su sociedad
  y su NIF, y su grupo del saldo es de una sola sociedad (pregunta 7).
  *Se comprueba*: el local piloto no sale en la consulta B.

---

## Consultas A y B

En Dokploy → `nightpay-postgres` → **Terminal** (`psql`), siempre en una
transacción de solo lectura que se deshace. Al dueño solo le llegan los totales.

```sql
BEGIN TRANSACTION READ ONLY;
SELECT set_config('app.bypass_rls', 'on', true);

-- A.1: lo gastado con saldo en 12 meses, por sociedad (y el total).
SELECT CASE WHEN GROUPING(v."businessId") = 1 THEN 'TOTAL' ELSE COALESCE(b.name, '(local sin sociedad)') END AS sociedad,
       v."businessId",
       SUM(c."amountCents" + c."tipCents") AS centimos
  FROM wallet_consumptions c
  JOIN venues v ON v.id = c."tenantId"
  LEFT JOIN businesses b ON b.id = v."businessId"
 WHERE c."reversedAt" IS NULL AND c."createdAt" >= now() - interval '12 months'
 GROUP BY ROLLUP ((v."businessId", b.name))
 ORDER BY GROUPING(v."businessId"), centimos DESC;

-- A.2: lo mismo, por grupo del saldo.
SELECT v."walletGroup", SUM(c."amountCents" + c."tipCents") AS centimos
  FROM wallet_consumptions c
  JOIN venues v ON v.id = c."tenantId"
 WHERE c."reversedAt" IS NULL AND c."createdAt" >= now() - interval '12 months'
 GROUP BY v."walletGroup"
 ORDER BY centimos DESC;

-- B: grupos del saldo (locales sin borrar) con más de una sociedad o algún local sin ella.
SELECT v."walletGroup",
       COUNT(*) AS locales,
       COUNT(DISTINCT v."businessId") AS sociedades,
       COUNT(*) FILTER (WHERE v."businessId" IS NULL) AS locales_sin_sociedad
  FROM venues v
 WHERE v."deletedAt" IS NULL AND v."walletGroup" IS NOT NULL
 GROUP BY v."walletGroup"
HAVING COUNT(DISTINCT v."businessId") > 1 OR COUNT(*) FILTER (WHERE v."businessId" IS NULL) > 0
 ORDER BY v."walletGroup";

ROLLBACK;
```

Si el grupo del local piloto sale en B: antes de encender se separan sus
locales (dejan de compartir saldo) o se espera (pregunta 7).

---

## Encender (de día, con la puerta entera marcada)

1. [ ] En la consola, con la API aún apagada: la empresa de los cajeros con su
   techo (`wallet:balance` + `wallet:load`), `venue_collects`, `in_venue` y
   sus IP.
2. [ ] En `nightpay-api`: `PARTNER_API_ENABLED=true` y `PARTNER_API_MODE=live`.
   **Nunca** `PARTNER_TEST_HELPERS`. Deploy, de día.
3. [ ] Desde fuera: `GET /v1/partner/openapi.json` da `200`, y un `POST` sin
   clave a `/v1/partner/test/live-codes` y a `/v1/partner/test/fixtures/reset`
   da `404 not_found` (si estuvieran montadas, darían `401`).
4. [ ] Cloudflare en **Full (strict)**. En `/v1/partner/*` solo se quita el
   desafío de bots (en el plan gratis, Bot Fight Mode apagado), con un límite
   de 200 peticiones en 10 s por IP. `GET /me` sin clave desde un servidor de
   los cajeros da un `401` en JSON, no en HTML.
5. [ ] El dueño, con su 2FA, conecta el local piloto: los dos permisos, sus IP
   y 12 meses. Si su respuesta a la pregunta 8 lo pide, **antes** de entregar
   la clave pone la noche a 2.000 € en «Topes». Entrega la clave por correo
   (el enlace de un solo uso); sin correo, con «La copio yo», pegándola él en
   el gestor de secretos de los cajeros. Nunca por chat ni por captura.
6. [ ] `GET /me` desde los cajeros: `livemode: true`, su emisor y sus topes, y
   `paused_scopes: []`. El enlace de la clave, abierto una sola vez. El
   teléfono del encargado de guardia, ya dado a los cajeros (pregunta 13).
7. [ ] Con el encargado, en el local:
   - tres fichas reales del local, sin `ficha_copy_suspected`;
   - un código del móvil;
   - 5,00 € cargados y anulados en 10 minutos (al dueño le llega «Carga
     anulada por una plataforma»);
   - «Movimientos» y «Caja · {socio}» del Z;
   - el registro y el log de esa hora, sin `qr`, sin UID, sin descripción,
     sin `?ficha=` y sin `oxp_live_`.

   Después, ya con clientes.

---

## Primera semana

- [ ] Cada mañana, el efectivo de cada cajero contra «Movimientos» (`net_loads`).
- [ ] Los avisos, contestados en el día.
- [ ] Una sola conexión de los cajeros en «Socios». Si aparece otra, se anula
  y se avisa al dueño.

---

## Marcha atrás (en este orden)

1. Anular la clave (de noche, el encargado de guardia, de un toque).
2. Congelar `money` o `all` en la consola.
3. `PARTNER_API_ENABLED=false` en `nightpay-api` y Deploy.

---

## Decisiones pendientes del sí del dueño

Decididas por su recomendación hasta que el dueño conteste por escrito.

| Pregunta | Decidido por recomendación | Bloquea encender |
|---|---|---|
| 1. Direcciones y demo | API real en el servidor de hoy (`/v1/partner`); la demo en un servidor pequeño aparte, `demo-api.`, `demo-admin.` y `demo-operator.` del dominio; la documentación en `developers.oxiocard.com`. **Pendiente del sí del dueño.** | Sí |
| 2. Panel de Dokploy | Solo por HTTPS o VPN, como condición para encender. **Pendiente del sí del dueño.** | Sí |
| 3. El correo | Resend en producción, probado antes con un correo a OxioPay (puerta 5). **Pendiente del sí del dueño.** | Sí (puerta 5) |
| 4. La empresa de los cajeros | Dada de alta como socio, con sus comprobaciones y su contrato de datos; la clave llega a su correo de contacto. **Pendiente del sí del dueño.** | Sí |
| 5. Lectores e impresora | Lector de QR y lector NFC con número de serie, probados en la demo con una ficha suya; todos imprimen tique. **Pendiente del sí del dueño.** | Sí |
| 6. Tarjeta en los cajeros | Solo efectivo (`422 funding_not_allowed`). **Pendiente del sí del dueño.** | No |
| 7. Local piloto | Peninsular, que ya cobre efectivo en recepción, con su sociedad real y un grupo de una sola sociedad, e IP fijas. **Pendiente del sí del dueño.** | Sí |
| 8. Efectivo de los cajeros | Contado aparte cada mañana, cajero por cajero, contra «Movimientos»; la noche a 2.000 € si se vacían menos de una vez al día. **Pendiente del sí del dueño.** | Sí |
| 9 a 12, 14 y 15 | Como están programados (recomendación de cada una). **Pendiente del sí del dueño.** | Solo si cambian (puerta 3) |
| 13. Clave filtrada de noche | El teléfono del encargado de guardia, que anula la clave de un toque. **Pendiente del sí del dueño.** | Sí |
| Volver a conectar Dokploy | Lo hace OxioPay, de día, antes de desplegar el PR 3 B, y lo comprueba con un Deploy de `main` y `/v1/health` (puerta 4). **Pendiente del sí del dueño.** | Sí (puerta 4) |
| Clave «Pruebas OxioPay» | Sí: sin lista de IP y con 50.000 € por noche, solo en la demo y guardada en el environment `demo` de GitHub (para `partner-demo` y la prueba de carga). **Pendiente del sí del dueño.** | No |

El dueño firma también, por escrito, lo que puede hacer una clave robada con
los topes que elija (§5 del encargo 8 B).

---

## Antes de encender, la demo

- `partner-demo` (GitHub → Actions → **partner-demo** → Run workflow, en
  `main`): comprueba la demo contra las guías con `OXP_DEMO_KEY` y
  `OXP_DEMO_BASE` del environment `demo`. Nunca contra producción.
- La prueba de carga (`apps/e2e/partner/carga.mjs`), a mano desde España con
  la clave «Pruebas OxioPay», una vez por noche y nunca a la vez que
  `partner-demo`:

  ```bash
  OXP_KEY=<clave oxp_test_ de «Pruebas OxioPay»> OXP_BASE=https://<demo-api>/v1/partner MINUTOS=10 node apps/e2e/partner/carga.mjs
  ```

  Pasa con cero 5xx y 429, p95 por debajo de 300 ms, la ráfaga con justo dos
  `201` y cuatro `402 limit_exceeded` (`wallet_24h`), `paused_scopes` vacío y
  `/statement` igual a la suma de sus `201`. Los dos guiones se niegan con
  cualquier clave que no sea `oxp_test_`.

Una `OXP_DEMO_KEY` filtrada solo toca datos inventados: se anula en la consola
de la demo y se cambia el secreto.
