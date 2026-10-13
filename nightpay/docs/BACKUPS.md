# Copias de seguridad de la base de datos

La base de datos (`nightpay-postgres` en Dokploy) guarda los cobros, los
saldos de los clientes y lo que se debe a cada chica. Si se pierde el disco del
VPS sin copia, se pierde todo. Esto deja:

- **copias automáticas** cada 6 horas en Cloudflare R2 (fuera del VPS);
- **un vigilante** en el API: si pasa más de un día sin copias, sale en
  Incidencias y llega por Telegram.

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
3. Arranca `nightpay-api`. Al arrancar aplica las migraciones que falten.
4. Lo cobrado entre la copia y el fallo no está en la base: sale en el portal
   de BBVA/Redsys y de Paytef. Sube esos días en **Banco** (cuadre con el
   banco) y aparecerán como «solo en el banco» para revisarlos uno a uno.

## Notas

- Las copias las programa Dokploy: si Dokploy está parado, no hay copias. El
  vigilante del API lo detecta igual (no ve copias nuevas).
- Si cambias el nombre del servicio de Postgres, cambia la carpeta en R2:
  actualiza `BACKUP_S3_PREFIX`.
- Redis no necesita copia: solo guarda colas y marcas temporales.
