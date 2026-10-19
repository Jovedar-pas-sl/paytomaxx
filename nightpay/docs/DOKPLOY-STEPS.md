# OxioPay / NightPay — despliegue paso a paso en Dokploy

Guion para montar OxioPay en un VPS con Dokploy detrás de Cloudflare (o para
rehacerlo si se pierde el servidor: ver también
[`runbooks/P0-vps-perdido.md`](runbooks/P0-vps-perdido.md)). Sigue las fases
en orden. En los ejemplos, `<IP-del-VPS>` es la IP pública del servidor y
`paytomaxx.com` el dominio actual.

> Este es el documento vigente. `DEPLOYMENT.md` (Coolify) está obsoleto.

---

## Fase 0 — Secretos (una sola vez)

Genera cada uno en tu equipo y guárdalos en el gestor de contraseñas **antes**
de seguir:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Secreto | Para qué | Ojo |
|---|---|---|
| `JWT_SECRET` | Firma las sesiones | Cambiarlo cierra todas las sesiones |
| `COOKIE_SECRET` | Firma las cookies | |
| `ENCRYPTION_KEK` | Cifra credenciales de pasarela y el PIN del saldo | **Si se pierde, no se recupera**: guárdalo en dos sitios |
| `ORIGIN_AUTH_SECRET` | Cabecera que pone Cloudflare (Fase F) | Mín. 24 caracteres |
| `METRICS_TOKEN` | Leer `/v1/metrics` desde fuera | Mín. 24 caracteres |
| Contraseña de Postgres | Usuario `np` | `base64url`, sin `@ : /` |
| Contraseña de Redis | | igual |

---

## Fase A — Conectar Dokploy a GitHub

1. Dokploy → **Settings → Git Providers → GitHub → Add**.
2. **Connect with GitHub**, instala la app en GitHub solo para el repositorio
   `paytomaxx`.

Comprobación: en Git Providers sale «GitHub: Connected».

---

## Fase B — Proyecto, Postgres y Redis

1. **Projects → Create Project** → `nightpay`.
2. **Create Service → Database → PostgreSQL**: nombre `nightpay-postgres`,
   imagen `postgres:16-alpine`, base `nightpay`, usuario `np`, la contraseña
   de la Fase 0, **sin puerto externo**. Create → Deploy. Apunta el *Internal
   Host*.
3. **Create Service → Database → Redis**: nombre `nightpay-redis`, imagen
   `redis:7-alpine`, la contraseña de la Fase 0, sin puerto externo. En
   **Advanced → Command**:
   `redis-server --requirepass <contraseña> --appendonly yes --maxmemory-policy noeviction`
   (obligatorio para las colas: ver [`BACKUPS.md`](BACKUPS.md) apartado 8).
   Create → Deploy.
4. Copias de seguridad: [`BACKUPS.md`](BACKUPS.md) (hazlo el mismo día).

---

## Fase C — Simuladores de pasarela: NO en producción

`apps/mock-wipay` y `apps/mock-peanpe` son simuladores para **desarrollo**
(aceptan cualquier pago). No se despliegan en Dokploy. En local van en
`docker compose up mock-wipay mock-peanpe`. Si existen servicios
`nightpay-mock-*` en Dokploy de una instalación antigua, bórralos.

---

## Fase D — API

### D.1 Servicio

`nightpay` → **Create Service → Application**:

| Campo | Valor |
|---|---|
| Name | `nightpay-api` |
| Source | GitHub, repo `ainhoanochesdeverano-dotcom/paytomaxx`, rama `main` |
| Build Type | Dockerfile |
| Build Context | `nightpay` |
| Dockerfile | `apps/api/Dockerfile` |
| Port | `4100` |
| Build Args (opcional) | `GIT_SHA=<commit>` y `BUILD_MARKER=<etiqueta>`: salen en `/v1/health` |
| Autodeploy | **Apagado** (ver abajo) |

**Desplegar solo con CI en verde.** Con el autodeploy encendido, Dokploy
despliega cada push a `main` aunque `nightpay-ci` falle (o aún no haya
terminado). Apágalo en `nightpay-api` (y en las webs de la Fase E) →
**General → Autodeploy: off**, y despliega así:

1. En GitHub → **Actions → nightpay-ci**, espera a que el run del commit de
   `main` salga en verde (`check`, `integracion`, `migraciones-orden` y
   `docker`). En `main` un push nuevo ya no cancela el CI del anterior.
2. Dokploy → `nightpay-api` → **Deploy** (manual) — fuera de la noche de
   cobro, ver D.5.

Opcional, para no hacerlo a mano: Dokploy → `nightpay-api` → **Deployments →
Webhook URL**, guárdala en GitHub como secreto `DOKPLOY_DEPLOY_WEBHOOK_API` y
añade al workflow un job que solo corre en `main` tras los demás:

```yaml
  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    needs: [check, integracion, migraciones-orden, docker]
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -X POST "${{ secrets.DOKPLOY_DEPLOY_WEBHOOK_API }}"
```

(Así también se despliega de noche si se hace push a esas horas: el manual
deja elegir el momento.) Otra opción es proteger `main` en GitHub con esos
checks obligatorios, pero no impide que Dokploy despliegue un push directo.

### D.2 Variables de entorno

Pestaña **Environment** (lista completa y explicada en `nightpay/.env.example`):

```env
NODE_ENV=production
PORT=4100
LOG_LEVEL=info

DATABASE_URL=postgresql://np:<POSTGRES_PASSWORD>@nightpay-postgres:5432/nightpay
REDIS_URL=redis://default:<REDIS_PASSWORD>@nightpay-redis:6379

JWT_SECRET=<Fase 0>
COOKIE_SECRET=<Fase 0>
ENCRYPTION_KEK=<Fase 0>
ORIGIN_AUTH_SECRET=<Fase 0>
METRICS_TOKEN=<Fase 0>

NEXT_PUBLIC_API_URL=https://api.paytomaxx.com
NEXT_PUBLIC_OPERATOR_URL=https://operator.paytomaxx.com
NEXT_PUBLIC_WEB_CLIENT_URL=https://pay.paytomaxx.com
OPERATOR_BASE_URL=https://operator.paytomaxx.com
CORS_ORIGINS=https://admin.paytomaxx.com,https://operator.paytomaxx.com,https://pay.paytomaxx.com,https://tpv.paytomaxx.com

# Redsys (TPV de BBVA)
REDSYS_API_URL=https://sis.redsys.es/sis/realizarPago
REDSYS_MERCHANT_CODE=<FUC>
REDSYS_TERMINAL=<terminal>
REDSYS_SECRET_KEY=<clave de firma>

# Obligatorias aunque Peanpe no se use
PEANPE_API_URL=https://peanpe.invalid/api
PEANPE_WEBHOOK_SECRET=<cualquier cadena de 8+>

# Avisos y copias (ver PUESTA-EN-MARCHA.md y BACKUPS.md)
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat id>
BACKUP_S3_ENDPOINT=https://<id-de-cuenta>.r2.cloudflarestorage.com
BACKUP_S3_REGION=auto
BACKUP_S3_BUCKET=oxiopay-copias
BACKUP_S3_PREFIX=nightpay-postgres-xxxxx/
BACKUP_S3_ACCESS_KEY_ID=<solo lectura>
BACKUP_S3_SECRET_ACCESS_KEY=<solo lectura>
BACKUP_MAX_AGE_HOURS=8

DEBUG_ENDPOINTS_ENABLED=false
```

Notas:
- El host interno de Postgres/Redis es el *Application Name*; si falla,
  `docker network inspect dokploy-network`.
- Redis lleva el prefijo `default:` antes de la contraseña.
- `DATABASE_URL` con `np` (superusuario) es el montaje inicial. Para que el API
  entre con un rol sin superusuario (RLS de la base aísla los locales):
  [`DB-ROLE.md`](DB-ROLE.md).
- `NODE_ENV` sin poner también arranca como producción; ponlo igual.
- Sin `ORIGIN_AUTH_SECRET` o `METRICS_TOKEN` el API no arranca en producción.
  Tampoco sin `CORS_ORIGINS` o con una dirección mal escrita (cada una
  `https://dominio`, sin barra final ni ruta).
- `REALTIME_LEGACY_SUBSCRIBE_UNTIL` (opcional): hasta cuándo las apps
  antiguas pueden seguir un cobro en tiempo real sin sesión. Sin ponerla, el
  martes 2026-11-17 a las 12:00 (Madrid); después contestan «Inicia sesión otra
  vez». Fecha ISO con zona (`2026-11-24T12:00:00+01:00`) para alargarla (un
  martes o miércoles a mediodía, nunca en plena noche), `off` para cerrarla
  ya: ponla a `off` a mano en cuanto `nightpay_ws_legacy_subscribes_total` en
  `/v1/metrics` lleve días sin subir.
- `AUTH_BODY_REFRESH_UNTIL` (opcional): hasta cuándo las apps antiguas del
  personal pueden renovar la sesión con la llave a la antigua (en la
  petición); las nuevas usan la cookie. Sin ponerla, el martes 2026-12-01 a
  las 12:00 (Madrid); fecha ISO con zona para alargarla, `off` para cerrarla
  ya (a mano, en cuanto `nightpay_auth_body_refresh_total{client="legacy"}`
  lleve días quieta).
  `CORS_ORIGINS` tiene que llevar exactas las direcciones de las apps: sin
  ellas no se puede entrar. Ver [`SESION-PERSONAL.md`](SESION-PERSONAL.md).

### D.3 Salud, parada y despliegues sin cortes

En **Advanced** (Swarm Settings) del servicio:

- **Health check**: el de la imagen (`/v1/health/live`, cada 30 s). Si Dokploy
  pide uno: test `CMD node -e "require('http').get('http://127.0.0.1:4100/v1/health/live',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"`,
  interval 30 s, timeout 8 s, start period 60 s, retries 5.
- **Update Config**: `Order: start-first` y `FailureAction: rollback`: el
  contenedor nuevo arranca, aplica migraciones y tiene que estar *healthy*
  antes de quitar el viejo; si no llega a sano, se queda el viejo.
- **Stop grace period**: `30s`. Al redesplegar, el API recibe SIGTERM y
  termina lo que tiene entre manos antes de cerrarse.

`/v1/health/live` solo dice «el proceso responde» (no mira la base: reiniciar
el API no arregla una base caída). `/v1/health` mira Postgres y Redis y da
503 si falla algo: es el del monitor externo (Fase G).

### D.4 Dominio

**Domains → Add**: host `api.paytomaxx.com`, path `/`, HTTPS con Let's
Encrypt.

### D.5 Deploy

**Deploy** y mira el log. El build tarda 3–5 min la primera vez
(`pnpm install --frozen-lockfile`, `prisma generate`). Al arrancar, el
contenedor:

1. `db-heal`: avisa si hay migraciones fallidas (no cambia nada).
2. `prisma migrate deploy`: crea o pone al día la base. **No hay paso de
   migración a mano**, tampoco la primera vez.
3. `db-heal` otra vez (avisos de solo lectura).
4. Arranca el API.

**Despliega fuera del horario de apertura** (de día, entre semana), sobre todo
si el commit trae migraciones: corren con el API anterior todavía sirviendo
(`start-first`). Las que hacen `ALTER` empiezan con `SET lock_timeout = '5s'`:
si una transacción en curso tiene la tabla (un cobro, una recarga), la
migración falla a los 5 s en vez de dejar en cola detrás de ella todas las
escrituras de los saldos. Si pasa (`canceling statement due to lock
timeout` en el log): sigue sirviendo el contenedor viejo; haz los pasos 3 y 4
de D.8 (`migrate resolve --rolled-back <nombre>` y **Redeploy**) en un rato
más tranquilo. Las migraciones son idempotentes: volver a aplicarlas es seguro.

### D.6 Comprobar

```bash
curl https://api.paytomaxx.com/v1/health
# {"status":"ok",…,"checks":{"api":"ok","db":"ok","redis":"ok"}}
```

### D.7 Primer local y primer usuario (solo en una instalación nueva)

No hay seed en producción (el de desarrollo ni siquiera va en la imagen).
Dokploy → `nightpay-api` → **Terminal**:

```bash
cd /repo/packages/db
./node_modules/.bin/tsx scripts/cli.ts create-venue --name "Luna Valencia" --slug luna-vlc
./node_modules/.bin/tsx scripts/cli.ts create-owner --venue luna-vlc --email <tu-correo> --password '<contraseña larga>'
./node_modules/.bin/tsx scripts/activate-redsys.ts --venue luna-vlc          # enseña qué haría
./node_modules/.bin/tsx scripts/activate-redsys.ts --venue luna-vlc --apply  # deja Redsys activo
```

`activate-redsys.ts` deja Redsys como pasarela del local (antes lo hacía el
arranque del API en todos los locales, cada vez). En producción ya está hecho
para los locales actuales: solo hace falta con un local nuevo.

### D.8 Si falla una migración

El API no arranca y el log dice `MIGRACIONES FALLIDAS: <nombre>` o
`P3009`. **No borres la base ni el esquema.**

1. Lee el error de esa migración en el log del despliegue.
2. Restaura una copia en una base de prueba (BACKUPS.md, apartado 5) y
   reproduce el problema allí.
3. Arregla la causa (normalmente datos que la migración no esperaba) y marca
   la migración como deshecha para que se vuelva a aplicar:
   `./node_modules/.bin/prisma migrate resolve --rolled-back <nombre>`
   (Terminal de `nightpay-api`, carpeta `/repo/packages/db`).
4. **Redeploy**.

Mientras tanto, con `start-first` sigue sirviendo la versión anterior. Si no,
**Deployments → la anterior → Rollback**.

---

## Fase E — Webs

Repetir por cada una con los mismos campos que el API salvo:

| App | Dockerfile | Port | Dominio |
|-----|------------|------|---------|
| admin | `apps/admin/Dockerfile` | `4103` | `admin.paytomaxx.com` |
| operator | `apps/operator/Dockerfile` | `4104` | `operator.paytomaxx.com` |
| tpv | `apps/tpv/Dockerfile` | `4102` | `tpv.paytomaxx.com` |
| web-client | `apps/web-client/Dockerfile` | `4101` | `pay.paytomaxx.com` |

`NEXT_PUBLIC_API_URL` y `NEXT_PUBLIC_WS_URL` se meten **al construir** la
imagen, no al arrancar: van en **Build Args** (no en Environment), y cambiarlas
exige **Rebuild**:

```
NEXT_PUBLIC_API_URL=https://api.paytomaxx.com
NEXT_PUBLIC_WS_URL=wss://api.paytomaxx.com
```

En **Environment** basta `NEXT_TELEMETRY_DISABLED=1`.

---

## Fase F — Cloudflare

1. DNS: `api`, `admin`, `operator`, `tpv`, `pay` → `<IP-del-VPS>`, proxy
   naranja.
2. **SSL/TLS → Full (strict)** (cuando Let's Encrypt ya haya emitido).
3. **Rules → Transform Rules → Modify Request Header**: añadir
   `X-Origin-Auth: <ORIGIN_AUTH_SECRET>` en las peticiones a
   `api.paytomaxx.com`. Sin ella el API rechaza lo que no venga de Cloudflare
   (salvo `/v1/health*` y los avisos del banco). Más en
   [`PUESTA-EN-MARCHA.md`](PUESTA-EN-MARCHA.md).
4. **Network → WebSockets: On** (tiempo real del TPV y del operador).

---

## Fase G — Saber que algo se ha caído

1. **Monitor externo** (UptimeRobot o Better Stack, plan gratis): monitor
   HTTP(S) a `https://api.paytomaxx.com/v1/health`, cada 1–5 min, alerta si no
   responde 200. Aviso a **Telegram** (integración nativa de los dos) al mismo
   grupo que las alertas del API. Añade uno por web (`https://admin…`, etc.).
   Es lo único que avisa si se cae el VPS entero: las alertas del API no salen
   si el API no está.
2. **Alertas del propio API por Telegram** (incidencias, copias, resumen de
   las 9:00): [`PUESTA-EN-MARCHA.md`](PUESTA-EN-MARCHA.md) apartado 3.
3. **Métricas** (opcional): `GET https://api.paytomaxx.com/v1/metrics` con
   `Authorization: Bearer <METRICS_TOKEN>` (formato Prometheus). Para
   gráficas, un Grafana Agent / Alloy en la red `dokploy-network` que lea
   `http://nightpay-api:4100/v1/metrics` (dentro de la red no hace falta el
   token) y lo mande a Grafana Cloud. Panel de ejemplo:
   `docs/grafana-dashboard.json`. Reglas útiles: `nightpay_circuit_state >= 2`
   (pasarela cortada), `nightpay_duplicate_charges_total` que sube.

---

## Problemas frecuentes

### El build falla en `pnpm install --frozen-lockfile`
`pnpm-lock.yaml` no cuadra con algún `package.json`: en local
`pnpm install`, commit del lockfile y push.

### El API arranca pero `/v1/health` da 502
Cloudflare manda tráfico antes de que el contenedor esté listo (con
`start-first` no debería pasar). Si sigue: Dokploy → `nightpay-api` → Logs.

### `/v1/health` da 503
Mira `checks`: `db: fail` → [`runbooks/P1-db-overload.md`](runbooks/P1-db-overload.md);
`redis: fail` → Redis caído o contraseña mal en `REDIS_URL`.

### Let's Encrypt no emite el certificado
Pon el subdominio en gris (sin proxy) 5 min en Cloudflare, deja que Dokploy
emita y vuelve a naranja. Alternativa permanente: certificado de origen de
Cloudflare.

### Volver a la versión anterior
Dokploy → servicio → **Deployments** → la anterior → **Rollback**
(o Redeploy de ese commit). Las migraciones no se deshacen solas: si la
versión nueva traía una, la anterior tiene que convivir con ella (todas las
migraciones de este repo son aditivas).

---

## Resumen del orden

```
Fase 0  Secretos
Fase A  Dokploy ↔ GitHub
Fase B  Postgres + Redis (+ copias: BACKUPS.md)
Fase C  (simuladores: no en producción)
Fase D  API: variables, salud/parada, deploy (migra solo), primer usuario
Fase E  Webs (NEXT_PUBLIC_* como Build Args)
Fase F  Cloudflare: DNS, Full (strict), X-Origin-Auth, WebSockets
Fase G  Monitor externo → Telegram, alertas del API, métricas
```
