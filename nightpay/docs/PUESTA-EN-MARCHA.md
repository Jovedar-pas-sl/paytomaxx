# Puesta en marcha — cuadre con el banco, copias y lo pendiente

Guía para el despliegue de la rama `feat/cuadre-banco` y lo que queda por hacer
fuera del código. Cada bloque dice cuánto tarda; hazlos en este orden.

---

## 1. Publicar (5 min)

```
# desde tu copia del repo
git push origin feat/cuadre-banco:main
```

En Dokploy, **Deploy** en:

- **nightpay-api**: al arrancar aplica la migración `cuadre_banco` sola.
- **nightpay-admin**: la pestaña nueva **Banco**.

Comprobar: `https://api.paytomaxx.com/v1/health` → `"build":"cuadre-banco-2026-10-14"`.

En Incidencias aparecerá **«Las copias de seguridad no se vigilan»** hasta
hacer el paso 2. Es lo esperado.

## 2. Copias de seguridad (20 min) — lo más importante

Sigue [`BACKUPS.md`](./BACKUPS.md) entero, **incluida la prueba de
restauración** (paso 5). Sin eso no hay copia de verdad.

## 3. Alertas por Telegram (10 min)

1. En Telegram, habla con **@BotFather** → `/newbot` → nombre `OxioPay
   alertas` → te da el **token**.
2. Crea un grupo con quien deba recibir los avisos, añade el bot y escribe
   cualquier cosa en el grupo.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador y
   busca `"chat":{"id":-100…` → ese número (con el `-`) es el **chat id**.
4. Dokploy → **nightpay-api** → Environment:
   ```
   TELEGRAM_BOT_TOKEN=<token>
   TELEGRAM_CHAT_ID=<chat id>
   ```
   Guarda y **Deploy**.
5. Admin → **Incidencias** → debe decir «Alertas por Telegram: activadas» →
   botón de prueba → llega «✅ OxioPay: las alertas de tus locales llegan a
   este chat».

Desde ese momento llegan: cobros atascados, dobles cobros, diferencias con el
banco, copias que fallan… y el **resumen de las 9:00** de cada local.

## 4. Primer cuadre con el banco (10 min, cada mañana)

1. Entra en **canales.redsys.es** con el usuario del comercio.
2. **Consultas → Buscar** → fechas: ayer (o la última semana la primera vez)
   → **Buscar** → **Exportar tabla** (descarga un CSV).
3. Admin → **Banco** → **BBVA · TPV virtual (QR)** → elige el fichero →
   **Cuadrar**.
4. Lo normal es «todo cuadra». Si sale algo:
   - **Falta en el banco**: aquí consta pagado y el banco no lo tiene. No
     pagues a la chica hasta aclararlo.
   - **Cobrado en el banco, aquí sin pagar**: se perdió el aviso del banco.
     Pagos → ese cobro → Resolver con la autorización que sale en el cuadre.
   - **Solo en el banco**: un cobro hecho fuera del sistema.
   - **Devolución sin apuntar**: apúntala en Pagos → Devolución hecha en BBVA.
5. Datáfonos (Paytef): lo mismo con el fichero de operaciones de
   **my.paytef.es** → **Paytef · datáfonos**. Si dice que no reconoce las
   columnas, pásame el fichero y lo ajusto (su formato no está publicado).

Si un día no se sube, el resumen de las 9:00 lo recuerda.

## 5. Prueba real completa (30 min, con una tarjeta propia)

Marca cada punto:

- [ ] **Cobro con QR y propina**: la chica crea un cobro de 1 € → el cliente
      añade 0,50 € de propina → paga con tarjeta → «Pagado» en los dos móviles.
- [ ] **Apple Pay / Google Pay**: otro cobro de 1 € con el botón de Apple Pay
      (iPhone) o Google Pay (Android). Nunca se ha probado en producción. Si
      BBVA no tiene Apple Pay / Google Pay («xpay») en el TPV, pon
      `PAY_DIRECT_WALLET=false`: el botón principal lleva entonces a la página
      del banco (tarjeta) en vez de abrir la cartera del móvil.
- [ ] **Saldo**: recarga de 2 € → el móvil que paga ve «Abrir mi saldo» →
      la página del saldo enseña el QR → la chica pulsa «Escanear QR del
      cliente» → pide 1 € → el cliente acepta en su móvil → le quedan 1 €.
- [ ] **«Me voy»**: el cliente pulsa «Me voy» → sale en Incidencias →
      Wallets → Devolver saldo → efectivo (como encargado).
- [ ] **Enlace nuevo**: Wallets → Enlace nuevo en otro saldo → el QR nuevo
      abre el saldo; el enlace viejo ya no.
- [ ] **Devolución a tarjeta**: devuelve 1 € en el portal de BBVA → Pagos →
      Devolución hecha en BBVA → la parte de la chica baja.
- [ ] **Al día siguiente**: sube el fichero de Canales de ese día → todo lo
      anterior tiene que cuadrar.
- [ ] **Resumen de las 9:00** llega por Telegram.
- [ ] **Datáfono PAX**: cuando Paytef conteste (claves de la Device API y
      PAXSTORE), vincular un datáfono en Datáfonos → App OxioPay y cobrar 1 €.

## 6. Seguridad del servidor (hazlo conmigo, 30–60 min)

Son cambios en el VPS y en Cloudflare, sin código. Mejor hacerlos juntos y
con calma, porque un error deja la web sin servicio:

1. **El panel de Dokploy** está en `http://<IP-del-VPS>:3000`, sin https y
   abierto a internet. Ponle un dominio con https (Dokploy → Settings → Web
   Server) o deja el puerto 3000 cerrado salvo para tu IP, y activa el doble
   factor del usuario de Dokploy.
2. **Que al servidor solo llegue tráfico de Cloudflare** (puertos 80/443
   abiertos solo a los rangos de https://www.cloudflare.com/ips/). Ojo:
   Docker se salta `ufw`. Hay que hacerlo en el firewall del proveedor del
   VPS, con una lista de IPs permitidas en Traefik, o con un Cloudflare
   Tunnel (lo más limpio: el servidor no expone puertos).
3. Cloudflare → SSL/TLS → **Full (strict)**.

## 7. Limpieza de Dokploy (10 min)

1. **Borrar la app vieja `nightpay-operator`** (la que se rompió). La buena
   es `nightpay-operator-2`. Stop → Delete.
2. **Despliegue automático** (hoy hay que pulsar Deploy a mano). En cada app
   (api, admin, operator-2, tpv, web-client) → pestaña **Deployments** →
   copia la **Webhook URL**. En GitHub → repositorio `paytomaxx` →
   Settings → Webhooks → **Add webhook**: pega la URL, Content type
   `application/json`, «Just the push event» → Add. Repite con cada app.
   Prueba: un push a `main` debe arrancar los despliegues solos.

## 8. Más adelante (planificado, no urgente)

- **Usuario de la base de datos.** La app entra en Postgres como
  superusuario, así que la protección entre locales de la propia base no
  actúa (la hace la app en cada consulta). Pasar a un usuario normal obliga a
  que la app fije el local en cada consulta. Es un cambio grande que hay que
  probar entero sobre una copia restaurada (paso 5 de BACKUPS.md) antes de
  tocar producción. Lo preparo cuando haya copias.
- **Dominio y correo de OxioPay** cuando compres el dominio: Dokploy (build
  args `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL`), Cloudflare, la URL de
  avisos en Paytef y recompilar la app del datáfono con `PAX_URL`.

## 9. Decisiones que solo puedes tomar tú

- ¿Una devolución también le quita **la propina** a la chica? (hoy solo la
  comisión).
- **IVA**: ¿intermediario o principal? (para el asesor).
- ¿Un **tope de cobro por noche**?
- ¿Todos los locales actuales son **del mismo dueño**? El saldo del cliente y
  el cuadre con el banco los tratan como un grupo.
