# Runbook P0: se ha perdido el VPS

El servidor no vuelve (disco roto, cuenta del proveedor bloqueada, borrado por
error). Todo lo de Dokploy estaba ahí: base de datos, Redis, servicios.

**Objetivos**

| | Objetivo | De qué depende |
|---|---|---|
| **RTO** (volver a cobrar con QR) | **4 horas** | tener a mano secretos y copias (abajo) |
| **RPO** (datos que se pueden perder) | **6 horas** como mucho | copias cada 6 h (Dokploy → R2, restic → B2) |

Lo cobrado entre la última copia y la caída **no se pierde en el banco**:
sale en el portal de BBVA/Redsys y de Paytef y se recupera con el cuadre
(paso 7).

Mientras dura: cobrar con **datáfono** (Paytef no depende de nuestro
servidor) o en efectivo, apuntado.

## Lo que hace falta tener ANTES (revísalo una vez al trimestre)

- [ ] En el gestor de contraseñas: `JWT_SECRET`, `COOKIE_SECRET`,
      **`ENCRYPTION_KEK`** (sin ella no se pueden usar el PIN del saldo ni las
      credenciales cifradas), `ORIGIN_AUTH_SECRET`, `METRICS_TOKEN`,
      contraseñas de Postgres y Redis, claves de Redsys, token de Telegram,
      claves de R2/B2 y **la contraseña de restic**.
- [ ] Copia de las variables de **Environment** de cada servicio de Dokploy
      (exportadas a un fichero cifrado o en el gestor).
- [ ] Copias recientes en R2 **y** en B2 ([`../BACKUPS.md`](../BACKUPS.md)),
      probadas con `scripts/restore-check.sh` este mes.
- [ ] Acceso a Cloudflare (DNS) y a GitHub.

## Pasos

1. **Avisar** (5 min): grupo de encargados → «cobrad con datáfono o
   efectivo hasta nuevo aviso». En Cloudflare, nada todavía.
2. **VPS nuevo** (15 min): mismo proveedor u otro (Hetzner, Contabo…),
   Ubuntu LTS, 4 GB de RAM o más. Apunta su IP (`<IP-nueva>`).
3. **Dokploy** (10 min): por SSH, `curl -sSL https://dokploy.com/install.sh | sh`.
   Entra en `http://<IP-nueva>:3000`, crea el usuario (con doble factor) y no
   dejes el panel abierto a internet más de lo necesario
   ([`../PUESTA-EN-MARCHA.md`](../PUESTA-EN-MARCHA.md) apartado 6).
4. **Rehacer el despliegue** (60–90 min) con
   [`../DOKPLOY-STEPS.md`](../DOKPLOY-STEPS.md), Fases A–E, **con los mismos
   secretos de antes** (no generes nuevos: la copia de la base depende de
   `ENCRYPTION_KEK`). Postgres y Redis primero; **no** despliegues aún el API.
5. **Restaurar la base** (20–40 min), en el Postgres nuevo y vacío:
   - Desde R2: Dokploy → Settings → Destinations → añade el R2 (mismas claves)
     → `nightpay-postgres` → **Backups → Restore** → la última copia.
   - O desde restic (si R2 no está disponible):
     `restic -r b2:oxiopay-restic:nightpay dump latest nightpay.dump > nightpay.dump`
     y `pg_restore --no-owner -d nightpay` dentro del contenedor de Postgres.
   - Comprueba: `select count(*), max("createdAt") from payments;`
6. **API y webs**: Deploy de `nightpay-api` (aplica las migraciones que
   falten) y de las cuatro webs. `curl http://<IP-nueva>` con el host del API
   o, más fácil, sigue al paso 7 y prueba por el dominio.
7. **DNS** (5 min + propagación): Cloudflare → DNS → `api`, `admin`,
   `operator`, `tpv`, `pay` → `<IP-nueva>` (proxy naranja). Con el proxy, el
   cambio es casi inmediato. La regla `X-Origin-Auth` y Full (strict) siguen
   valiendo. Si Let's Encrypt no emite: ver DOKPLOY-STEPS, «Problemas
   frecuentes».
8. **Comprobar**:
   - [ ] `https://api.paytomaxx.com/v1/health` → `ok` (y el monitor externo
         vuelve a verde).
   - [ ] Cobro de 1 € con QR, de principio a fin (incluido el aviso de Redsys:
         la URL de avisos es el dominio, no cambia).
   - [ ] Panel → Incidencias: botón de prueba de Telegram.
   - [ ] Datáfonos PAX: siguen funcionando (hablan con el dominio).
9. **Recuperar lo de entre la copia y la caída**: Panel → **Banco** → sube el
   fichero de Redsys (canales.redsys.es) y el de Paytef de esos días. Lo que
   salga como «solo en el banco» son cobros reales sin apuntar: revísalos uno a
   uno (y la parte de las chicas).
10. **Copias otra vez**: vuelve a programar las copias de Dokploy y el
    contenedor de restic ([`../BACKUPS.md`](../BACKUPS.md)) en el VPS nuevo.
11. Avisar a los locales y escribir el postmortem
    ([`../postmortems/TEMPLATE.md`](../postmortems/TEMPLATE.md)).
