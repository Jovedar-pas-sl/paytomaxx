# Copias de seguridad de la base de datos

La base de datos (`nightpay-postgres` en Dokploy) guarda los cobros, los
saldos de los clientes y lo que se debe a cada chica. Si se pierde el disco del
VPS sin copia, se pierde todo. Esto deja:

- **copias automáticas** cada 6 horas en Cloudflare R2 (fuera del VPS);
- **una segunda copia que no depende de Dokploy** (restic, cifrada, en
  Backblaze B2): si Dokploy se rompe o se borra el proyecto, sigue habiendo
  copias (apartado 7);
- **un vigilante** en el API: si pasa más de un día sin copias, sale en
  Incidencias y llega por Telegram;
- **una prueba de restauración con guion** (`scripts/restore-check.sh`).

Tiempo: unos 20 minutos. Coste: 0 € (R2 regala 10 GB; una copia comprimida
ocupa unos pocos MB).

---

## 1. El almacenamiento (Cloudflare R2)

Usa la misma cuenta de Cloudflare donde está el dominio.

1. Cloudflare → **R2 Object Storage** → **Create bucket** → nombre
   `oxiopay-copias` → ubicación automática → **Create**.
2. En R2 → **Manage API tokens** → **Create API token**:
   - Nombre `dokploy-copias`, permiso **Object Read & Write**, solo el bucket
     `oxiopay-copias` → **Create**.
   - Apunta **Access Key ID**, **Secret Access Key** y el **endpoint**
     (`https://<id-de-cuenta>.r2.cloudflarestorage.com`). El secreto solo se ve
     una vez.
3. Crea un segundo token igual pero con permiso **Object Read only**, de
   nombre `api-vigilante`. Es el que usará el API (solo mira, no puede borrar).

## 2. Dokploy: dónde guardar

Dokploy → **Settings → Destinations** → **Add Destination**:

| Campo | Valor |
|---|---|
| Name | `R2 copias` |
| Provider | `Cloudflare` |
| Access Key Id | el del token `dokploy-copias` |
| Secret Access Key | el del token `dokploy-copias` |
| Bucket | `oxiopay-copias` |
| Region | `auto` |
| Endpoint | `https://<id-de-cuenta>.r2.cloudflarestorage.com` (sin el bucket) |

Pulsa **Test connection**: tiene que salir bien antes de seguir.

## 3. Dokploy: la copia programada

Proyecto `nightpay` → servicio **nightpay-postgres** → pestaña **Backups** →
**Create Backup**:

| Campo | Valor |
|---|---|
| Destination | `R2 copias` |
| Database | `nightpay` |
| Schedule | `0 */6 * * *` (cada 6 horas) |
| Prefix | (vacío) |
| Keep the latest | `60` (15 días de copias) |
| Enabled | ✅ |

Pulsa **Test**: hace una copia de verdad. En Cloudflare → R2 →
`oxiopay-copias` tiene que aparecer una carpeta con el nombre interno del
servicio de Postgres (algo como `nightpay-postgres-xxxxx/`) y dentro un
fichero `…sql.gz`. **Apunta el nombre de esa carpeta** (paso 4).

> La copia es un `pg_dump` en formato propio de Postgres, comprimido. Aunque
> termine en `.sql.gz`, se restaura con `pg_restore` (Dokploy lo hace solo).

## 4. El vigilante del API

Dokploy → **nightpay-api** → **Environment**, añade:

```
BACKUP_S3_ENDPOINT=https://<id-de-cuenta>.r2.cloudflarestorage.com
BACKUP_S3_BUCKET=oxiopay-copias
BACKUP_S3_PREFIX=nightpay-postgres-xxxxx/
BACKUP_S3_REGION=auto
BACKUP_S3_ACCESS_KEY_ID=<del token api-vigilante>
BACKUP_S3_SECRET_ACCESS_KEY=<del token api-vigilante>
BACKUP_MAX_AGE_HOURS=8
```

`BACKUP_MAX_AGE_HOURS=8` porque hay copia cada 6 horas (si pones copia diaria,
déjalo en `26`). Guarda y **Deploy** de `nightpay-api`.

Cómo saber que funciona:

- Sin estas variables, en producción sale en Incidencias «Las copias de
  seguridad no se vigilan».
- Con ellas bien puestas, ese aviso desaparece.
- Si las copias dejan de llegar (o la clave está mal), sale «Sin copia de
  seguridad reciente de la base de datos» y llega por Telegram una vez al día
  hasta que se arregle.

## 5. Probar que se puede restaurar (hazlo una vez ahora y luego cada mes)

Una copia que nunca se ha restaurado no es una copia. **No restaures encima de
la base de producción** para probar: la sobrescribe.

**Con el guion (recomendado).** Descarga la última copia de R2 (Cloudflare →
R2 → `oxiopay-copias` → la carpeta de Postgres → el `.sql.gz` más reciente) o
la de restic (apartado 7) y, en cualquier máquina con Docker (el propio VPS
vale):

```bash
nightpay/scripts/restore-check.sh ./nightpay-xxxx.sql.gz
```

Levanta un Postgres 16 de usar y tirar (sin volumen: desaparece al acabar),
restaura la copia y comprueba que hay cobros (`payments`), saldos
(`client_wallets`) y comisiones (`operator_earnings`). Sale con error si la
copia no se restaura o alguna tabla está vacía. Para exigir además que la copia
sea reciente: `MAX_LAST_PAYMENT_AGE_DAYS=2 nightpay/scripts/restore-check.sh …`.
Sin Docker, contra una base vacía creada a mano: `… --url postgresql://…`
(se niega si la base tiene tablas).

**Desde el panel de Dokploy (alternativa).**

1. En el proyecto `nightpay` → **Create Service → Database → PostgreSQL**,
   nombre `restore-prueba`, imagen `postgres:16-alpine`, base `nightpay`.
2. En `restore-prueba` → **Backups** → **Restore** → Destination `R2 copias` →
   elige la última copia de `nightpay-postgres-xxxxx/` → Database `nightpay` →
   **Restore**.
3. En `restore-prueba` → **Terminal** (o `docker exec`):
   `psql -U postgres -d nightpay -c "select count(*), max(\"createdAt\") from payments;"`
   Tiene que salir el número de cobros y la fecha del último.
4. Borra `restore-prueba`.

## 6. Si un día se rompe la base

1. Para `nightpay-api` (para que no escriba nada).
2. En `nightpay-postgres` → **Backups → Restore** → la última copia buena →
   Database `nightpay`. Reemplaza lo que haya.
3. **Obligatorio antes de arrancar el API** (si `DATABASE_URL` entra con
   `oxiopay_app`): [`DB-ROLE.md`](DB-ROLE.md) **paso 2** (que `oxiopay_app`
   vuelva a ser el dueño de todo) **y su comprobación** («nada sigue siendo de
   `np`» → `(0 rows)`). Lo restaurado queda de `np`: sin esto el API da
   «permission denied» y la base deja de aislar los locales (RLS). Si el API
   aún entra con `np`, sáltatelo.
4. Arranca `nightpay-api`. Al arrancar aplica las migraciones que falten.
5. Lo cobrado entre la copia y el fallo no está en la base: sale en el portal
   de BBVA/Redsys y de Paytef. Sube esos días en **Banco** (cuadre con el
   banco) y aparecerán como «solo en el banco» para revisarlos uno a uno.

## Notas

- Las copias las programa Dokploy: si Dokploy está parado, no hay copias. El
  vigilante del API lo detecta igual (no ve copias nuevas).
- Si cambias el nombre del servicio de Postgres, cambia la carpeta en R2:
  actualiza `BACKUP_S3_PREFIX`.
- Redis no necesita copia: solo guarda colas y marcas temporales. Pero sí
  tiene que estar configurado para no perder trabajos (apartado 8).

## 7. Segunda copia, independiente de Dokploy (restic + Backblaze B2)

Las copias del apartado 3 las hace Dokploy: si Dokploy deja de funcionar, se
reinstala o alguien borra el servicio, se acaban. Esta segunda copia la hace un
contenedor pequeño que arranca Docker por su cuenta (no es un servicio de
Dokploy), cifra con [restic](https://restic.net) y guarda en otro proveedor
(Backblaze B2): ni Cloudflare ni Dokploy son punto único de fallo.

Coste: B2 regala 10 GB; las copias cifradas de restic deduplican y ocupan muy
poco.

1. **Backblaze** → B2 → **Create a Bucket** `oxiopay-restic` (privado) →
   **Application Keys → Add a New Application Key** solo para ese bucket,
   con lectura y escritura. Apunta `keyID` y `applicationKey`.
2. **Contraseña de restic**: genera una larga
   (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
   y guárdala en tu gestor de contraseñas **y en papel**. Sin ella las copias no
   se pueden abrir: ni tú ni nadie.
3. En el VPS, un fichero solo para root, `/root/restic-oxiopay.env`
   (`chmod 600`):

   ```env
   PGHOST=nightpay-postgres        # el nombre interno del Postgres en Dokploy
   PGUSER=np
   PGPASSWORD=<la de Postgres>
   PGDATABASE=nightpay
   RESTIC_REPOSITORY=b2:oxiopay-restic:nightpay
   RESTIC_PASSWORD=<la del paso 2>
   B2_ACCOUNT_ID=<keyID>
   B2_ACCOUNT_KEY=<applicationKey>
   # Opcional: aviso a Telegram si falla una copia (el mismo bot del API).
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   ```

4. El guion de la copia: copia `nightpay/scripts/restic-backup.sh` del repo al
   VPS como `/root/oxiopay-restic.sh` (`chmod 755`). Hace `pg_dump` → restic,
   borra las copias viejas (guarda 7 días de copias de cada 6 h, 8 semanas y
   12 meses) y avisa por Telegram si falla.
5. El contenedor (una sola vez; Docker lo vuelve a levantar solo tras
   reiniciar el VPS). Copia cada 6 h, a y media:

   ```bash
   docker run -d --name oxiopay-restic --restart unless-stopped \
     --network dokploy-network --env-file /root/restic-oxiopay.env \
     -v /root/oxiopay-restic.sh:/copia.sh:ro \
     alpine:3.24 sh -c 'apk add --no-cache postgresql16-client restic curl >/dev/null \
       && (restic cat config >/dev/null 2>&1 || restic init) \
       && export -p > /env.sh \
       && echo "30 */6 * * * . /env.sh && /copia.sh" | crontab - \
       && /copia.sh; exec crond -f -l 8'
   ```

   (El `-v` monta un fichero, no un volumen de Docker. `export -p` deja las
   variables a mano para el cron.)
6. Comprueba: `docker logs oxiopay-restic` → `copia OK …`, y
   `docker exec oxiopay-restic restic snapshots` lista la copia.

**Restaurar desde restic** (o probar, con el guion del apartado 5):

```bash
docker exec oxiopay-restic restic dump latest nightpay.dump > nightpay.dump
nightpay/scripts/restore-check.sh ./nightpay.dump
```

`latest` es siempre una copia completa: si `pg_dump` falla, la copia no se
guarda (el guion usa `--stdin-from-command`). Para otra anterior:
`restic snapshots` y `restic dump <id> nightpay.dump`.

Para devolverla a producción (en el VPS, como root):

1. Para `nightpay-api` (Dokploy → **Stop**).
2. Mete la copia en Postgres y restaura **como `np`** (sin `-U np` entra como
   `root`, que no existe en Postgres):

   ```bash
   PG=$(docker ps -qf name=nightpay-postgres | head -n1)
   docker exec -i "$PG" pg_restore -U np --clean --if-exists --no-owner -d nightpay < nightpay.dump
   ```

   (O, en dos pasos: `docker cp nightpay.dump "$PG":/tmp/nightpay.dump` y
   `docker exec "$PG" pg_restore -U np --clean --if-exists --no-owner -d nightpay /tmp/nightpay.dump`;
   después `docker exec "$PG" rm /tmp/nightpay.dump`.)
3. **Obligatorio antes de arrancar el API:** [`DB-ROLE.md`](DB-ROLE.md)
   **paso 2 y su comprobación** (`(0 rows)`). Con `--no-owner` todo queda de
   `np`: con `DATABASE_URL=…oxiopay_app…` el API daría «permission denied» y
   la base dejaría de aislar los locales (RLS).
4. Arranca `nightpay-api` y sigue con el punto 5 del apartado 6 (lo cobrado
   después de la copia).

## 8. Redis: que no tire trabajos

El API guarda en Redis las colas (BullMQ: avisos del banco, conciliaciones,
alertas). Redis tiene que:

- **no borrar claves aunque se llene** (`maxmemory-policy noeviction`): con la
  política por defecto podría tirar trabajos pendientes;
- **guardar en disco** (`appendonly yes`): un reinicio no pierde la cola.

En Dokploy → `nightpay-redis` → **Advanced** → *Command* (o *Args*):

```
redis-server --requirepass <la de Redis> --appendonly yes --maxmemory-policy noeviction
```

Guarda, **Redeploy** de Redis y compruébalo en su **Terminal**:

```bash
redis-cli -a '<la de Redis>' CONFIG GET maxmemory-policy   # → noeviction
redis-cli -a '<la de Redis>' CONFIG GET appendonly         # → yes
```
