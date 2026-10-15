# NightPay — Hardening operativo (Sprint B)

Lista de operaciones que hay que hacer ANTES de exponer el API a tráfico real (aunque sea de tus 6 locales).

## 1. Contraseñas de los usuarios (hecho en código)

El seed de desarrollo ya no lleva una contraseña conocida: la de los usuarios
nuevos sale de `SEED_PASSWORD` o se genera al azar, nunca cambia la de un
usuario que ya existe y se niega a correr en producción sin `SEED_PASSWORD`.
Tampoco va en la imagen del API. En producción, los usuarios se crean con
`pnpm cli create-owner` / `create-manager` (DOKPLOY-STEPS, D.7).

Si alguna vez se usó en producción la contraseña de demostración antigua
(la que publicaba esta documentación), cámbiala ya en cada usuario:

```powershell
pnpm cli reset-password --email <correo> --password "<contraseña larga>"
```

Genera contraseñas con: `node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"`.

## 2. Backups diarios

Script `scripts/backup-db.ps1` hace `pg_dump` + comprime + retención.

**Configurar Task Scheduler** (Windows):
- Programa: `powershell.exe`
- Argumentos: `-NoProfile -ExecutionPolicy Bypass -File "C:\Users\mehdi\Documents\GitHub\first_tries\nightpay\scripts\backup-db.ps1"`
- Trigger: diario 06:30 (después del cierre de noche)
- Configurar como "Run whether user is logged on or not"

Test manual:

```powershell
.\scripts\backup-db.ps1
```

Verás el archivo en `nightpay/backups/nightpay_<timestamp>.zip` (o `.gz` si tienes 7-Zip).

**Test de restore** (drill trimestral):

```powershell
# Crear DB temporal
docker exec -i nightpay_postgres psql -U np -d postgres -c "CREATE DATABASE nightpay_restore_test;"

# Restaurar
Get-Content backups\nightpay_<timestamp>.zip | docker exec -i nightpay_postgres psql -U np -d nightpay_restore_test

# Verificar conteo
docker exec -i nightpay_postgres psql -U np -d nightpay_restore_test -c "SELECT COUNT(*) FROM payments;"

# Limpiar
docker exec -i nightpay_postgres psql -U np -d postgres -c "DROP DATABASE nightpay_restore_test;"
```

## 3. Monitor de pagos atascados

Script `scripts/check-stuck-payments.ps1` busca pagos en `AUTHORIZING` >30 min.

Configurar Task Scheduler cada 10 min. Opcionalmente con Telegram:

1. Crear bot Telegram (BotFather) → guarda `bot_token`
2. Crear grupo / DM con el bot, manda `/start`, abre `https://api.telegram.org/bot<TOKEN>/getUpdates` para ver el `chat_id`
3. Programa el script con argumentos:

```powershell
.\scripts\check-stuck-payments.ps1 -TelegramBotToken "TU_BOT_TOKEN" -TelegramChatId "TU_CHAT_ID"
```

Si encuentra atascados → exit 1 + (opcional) mensaje Telegram. Sigue runbook `docs/runbooks/P0-pagos-atascados.md`.

## 4. .env.local — proteger en disco

`.env.local` tiene tus secretos JWT/cookie/KEK. Ya está gitignored, pero:

- En Windows, set ACL para que solo tu usuario pueda leerlo:

```powershell
icacls .env.local /inheritance:r /grant:r "$env:USERNAME:R"
```

- En producción, las variables van en Dokploy → servicio → Environment (docs/DOKPLOY-STEPS.md).

## 5. Cifrado de credenciales pasarela (cuando integres Wipay/Peanpe real)

El schema tiene `gateway_credentials.encKey/encNonce/encTag` con AES-256-GCM. El seed pone placeholders. Cuando configures Wipay real:

```powershell
# (futuro: pnpm cli set-credential — pendiente Sprint 6)
# Por ahora, dropea las creds del seed:
docker exec -i nightpay_postgres psql -U np -d nightpay -c "DELETE FROM gateway_credentials;"
```

Y reemplaza con un script que cifre con `ENCRYPTION_KEK`:

```javascript
// node scripts/set-credential.js <venueSlug> <provider> <api_key>
const crypto = require('crypto');
const kek = Buffer.from(process.env.ENCRYPTION_KEK, 'base64');  // 32 bytes
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce);
const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();
// Insert: encKey=enc, encNonce=nonce, encTag=tag, kekVersion=1
```

(TODO Sprint 6: añadir `pnpm cli set-credential` que haga esto.)

## 6. Cloudflare al frente (producción)

- DNS A record → IP del Hetzner VPS
- Proxy ON (naranja) — Cloudflare termina TLS, mitiga DDoS
- Rate limit rule en `/v1/auth/login` (5 intentos/IP/min)
- Rate limit en `/v1/payments` (100 req/min/IP) — protege contra abuse
- WAF managed rules ON

## 7. Logs

Pino en formato JSON ya está configurado. En producción:

- stdout va a los Logs de Dokploy → archivable a Loki/Grafana free tier
- Filtrar warnings/errors por keyword `[ERROR]` o `level: 50`

## 8. Health checks

`/v1/health` actualmente devuelve `db: skip` y `redis: skip`. Mejora antes de prod:

- Añadir checks reales (`SELECT 1` a Postgres, `PING` a Redis)
- Endpoint `/v1/ready` separado para load balancer (k8s style)

(TODO Sprint 6: `HealthService` con `@nestjs/terminus`.)

## 9. Audit log

`payment_events` ya graba todas las transiciones FSM. Pero también deberías loguear:

- Cambios de role en users
- Reset de passwords (quién lo hizo, cuándo)
- Cambios de gateway credentials
- Refunds (con autor y razón)

(TODO Sprint 6: tabla `audit_log` global + interceptor que grava todo `@AuditLog()`.)

## 10. CI badge + status page

- GitHub Actions ya verde (`ci.yml`). Añadir badge al README.
- Uptime Robot free → monitoriza `/v1/health` cada 5 min, status page pública en `status.nightpay.app`.

---

## Checklist mínimo antes de producción

- [ ] Passwords rotados (paso 1)
- [ ] Backup script programado en Task Scheduler
- [ ] Stuck-payment monitor programado + Telegram configurado
- [ ] `.env.local` con ACL solo para tu usuario
- [ ] Cloudflare proxying activo
- [ ] Health check con DB+Redis reales
- [ ] Drill de restore probado al menos 1 vez
- [ ] Status page pública configurada
