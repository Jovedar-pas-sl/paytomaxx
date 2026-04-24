# Deploy — Producción

Instalación completa desde cero en un VPS Linux. Sustituye `docs/INSTALL.md` (pre-WAHA).

## Requisitos previos

- VPS Ubuntu 22.04 o 24.04 LTS · 4 CPU · 8 GB RAM · 80 GB SSD (mínimo para 5 WAs)
- Dominio con acceso al panel DNS
- Anthropic API key (cuenta con créditos)
- **WAHA Plus Patreon** (~9 €/mes) + tu Docker Hub key (`dckr_pat_...`)
- Usuario sudoer en el VPS (no ejecutes como root)

## 1. Bootstrap del VPS

```bash
ssh tuuser@<IP-VPS>

# Clona solo este subfolder:
git clone <repo-url> ~/wa-ops
cd ~/wa-ops

# Mueve a /opt (convención del proyecto)
sudo mv ~/wa-ops /opt/wa-ops
cd /opt/wa-ops

# Bootstrap: Docker, UFW, fail2ban, .env con secretos random
bash scripts/install-vps.sh
```

El script instala Docker, abre puertos 22/80/443 en UFW, activa fail2ban y genera `.env` con passwords aleatorios para Postgres, Redis, JWT, etc.

## 2. Configura `.env`

```bash
sudo nano /opt/wa-ops/.env
```

Rellena **a mano** estos campos:

```env
DOMAIN=maxxagops.com                       # tu dominio
CADDY_EMAIL=admin@maxxagops.com            # para Let's Encrypt
ANTHROPIC_API_KEY=sk-ant-api03-...         # tu key
KPI_ADMIN_EMAIL=admin@maxxagops.com

# Genera el hash del password admin:
# python3 scripts/hash-admin-password.py
# Pega la salida tal cual (empieza por $2b$12$...)
KPI_ADMIN_PASSWORD_HASH=$2b$12$...
```

Los siguientes ya los ha rellenado el bootstrap con valores random (no tocar):
`POSTGRES_PASSWORD`, `KPI_DB_PASSWORD`, `JWT_SECRET`, `WAHA_API_KEY`, `WAHA_DASHBOARD_USERNAME`, `WAHA_DASHBOARD_PASSWORD`.

**Opcional**: si quieres HMAC en webhooks de WAHA, genera un secreto y ponlo en `WAHA_WEBHOOK_HMAC=...`. Si vacío, se acepta sin firma (dev).

## 3. DNS

Añade registros A apuntando a la IP del VPS:

```
kpi.<DOMAIN>    A    <VPS_IP>
wa.<DOMAIN>     A    <VPS_IP>       (swagger WAHA — protegido con auth)
<DOMAIN>        A    <VPS_IP>       (redirect a kpi.*)
admin.<DOMAIN>  A    <VPS_IP>       (legacy, Caddy redirige a apex)
```

Espera ~15 min a que propague. Comprueba con `dig kpi.<DOMAIN> +short`.

## 4. Imagen WAHA Plus

WAHA Plus es una imagen privada de Docker Hub que requiere login con tu key de Patreon (solo la 1ª vez):

```bash
docker login -u devlikeapro -p 'dckr_pat_TU_KEY'
docker pull devlikeapro/waha-plus:latest
docker logout
```

El `docker logout` borra el token del estado de Docker. **No commits ni guardes el token en ningún fichero del servidor.**

## 5. Up

```bash
cd /opt/wa-ops
docker compose up -d

# Mira logs mientras arranca (1-2 min la primera vez)
docker compose logs -f
```

Caddy tarda ~30s en obtener certificados. Cuando veas `certificate obtained successfully` el HTTPS está listo.

## 6. Primer login

1. Abre `https://kpi.<DOMAIN>` en el browser
2. Login con `KPI_ADMIN_EMAIL` + password que hasheaste
3. Ve a **/sessions** → **+ Nueva casa** → nombre
4. Dentro de la card de la casa → **+ Añadir WhatsApp**
5. Label: `Oficial`. Session name: `<slug>-oficial` (ej: `vlc-oficial`)
6. Pulsa **▶ Iniciar** → aparece QR → escanea con el teléfono
7. Status debe pasar a **WORKING**. Envía un mensaje de prueba desde otro móvil al número.
8. Ve a `/casas/<id>?tab=chats` — el mensaje debe aparecer.

## 7. Backups

`scripts/backup.sh` usa restic (cifrado). Configura una cron:

```bash
sudo crontab -e
```

```cron
# Backup diario a las 3 AM
0 3 * * * cd /opt/wa-ops && bash scripts/backup.sh >> /var/log/wa-ops-backup.log 2>&1
```

Restaura con `bash scripts/restore-backup.sh`. Prueba la restauración **en un VPS de staging** antes de confiar en ella.

## 8. Updates

Tras hacer cambios locales y empujarlos al repo:

```bash
# En el VPS
cd /opt/wa-ops
git pull
docker compose build kpi-app kpi-worker
docker compose up -d --force-recreate kpi-app kpi-worker

# Si cambió schema:
docker compose exec kpi-app alembic upgrade head
```

Si estás en Windows trabajando directamente vía scp (sin git remote), ver [CLAUDE.md](../CLAUDE.md) → "Convención de despliegue".

## Rollback

```bash
# Si un deploy rompe:
cd /opt/wa-ops
git log --oneline -5        # identifica el commit bueno previo
git checkout <sha>
docker compose build kpi-app kpi-worker
docker compose up -d --force-recreate kpi-app kpi-worker
```

Si el problema es en la migration, `alembic downgrade -1` y redeploy el código.

## Hardening adicional (opcional)

- **SSH sin password**: añade tu pubkey a `~/.ssh/authorized_keys` del VPS y en `/etc/ssh/sshd_config` pon `PasswordAuthentication no`. Reinicia `ssh`.
- **WAHA fuera del public**: quita la sección `wa.<DOMAIN>` del Caddyfile. El swagger de WAHA ya no es accesible desde internet; usa `ssh -L 3000:localhost:3000 ...` para llegar.
- **Postgres solo local**: verifica que el contenedor `postgres` no expone puerto al host (no hay `ports:` en el compose — ✅).
- **restic remote**: configura un bucket S3 / Backblaze B2 en `scripts/backup.sh` en vez de local.
