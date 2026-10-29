<p align="center">
  <img src="docs/capturas/icono.png" width="72" alt="">
</p>

<h1 align="center">OxioPay</h1>

<p align="center">
  <b>Cobros para el ocio nocturno: QR, saldo prepago con ficha NFC y datáfono,<br>
  con el reparto al personal y las cuentas del local en directo.</b>
</p>

<p align="center">
  <img src="docs/capturas/03-cobro-qr-nfc.webp" width="860" alt="El camarero cobra con su móvil: QR y NFC a la vez">
</p>

> Todas las capturas son de la demo, **con datos inventados** (Sala Aurora, Madrid).

---

## Qué es

En un local de noche se cobra rápido, con poca luz y con mucha gente. OxioPay
lo resuelve desde el móvil del personal:

- **El camarero cobra con su móvil.** Elige de la carta, enseña un QR y el
  cliente paga con tarjeta, Apple Pay o Google Pay. O acerca su ficha NFC y
  paga del saldo. Es un solo cobro: lo que llegue primero lo cierra.
- **El cliente paga en su móvil**, en español, inglés, francés o portugués,
  elige la propina y ve el total sin sorpresas. Al pagar, le sale un código
  para enseñárselo al personal.
- **El dueño lo ve todo en directo:** ventas, propinas, lo que es de cada
  chica, el dinero en caja, los avisos y el cierre de la noche con su Z.
- **OxioPay cobra su comisión** con una liquidación semanal por transferencia.

## Un cobro, de principio a fin

```mermaid
sequenceDiagram
    autonumber
    participant C as Camarero (app)
    participant A as API OxioPay
    participant K as Cliente (móvil)
    participant B as Banco (Redsys / BBVA)
    C->>A: Crea el cobro (carta o importe)
    A-->>C: QR + espera de NFC
    K->>A: Abre el QR, elige propina
    A->>B: Página de pago (tarjeta / Apple Pay / Google Pay)
    K->>B: Paga
    B-->>A: Aviso firmado de pagado
    A-->>K: PAGADO + código de confirmación
    A-->>C: Pagado (en tiempo real)
    A-->>A: Mapa del dinero, comisiones, liquidación
```

## El recorrido, en capturas

### 1. El camarero cobra

<p align="center">
  <img src="docs/capturas/01-camarero-carta.webp" width="49%" alt="La carta">
  <img src="docs/capturas/02-camarero-cuenta.webp" width="49%" alt="La cuenta">
</p>
<p align="center">
  <img src="docs/capturas/04-camarero-pagado.webp" width="60%" alt="Pagado en el móvil del camarero">
</p>

La carta va por secciones (copas, cocina, entradas…) y el cobro lleva su
desglose. El camarero ve el «Pagado» en cuanto el banco lo confirma.

### 2. El cliente paga, en su idioma

<p align="center">
  <img src="docs/capturas/cliente-pago-es.webp" width="260" alt="Página de pago">
  &nbsp;&nbsp;
  <img src="docs/capturas/cliente-pagado-es.webp" width="260" alt="Pagado con código de confirmación">
</p>

Total grande arriba, propina con un toque, la **comisión del servicio** con su
«¿Qué es?» y Apple Pay / Google Pay como botón principal. En el «Pagado», el
código que el cliente enseña al personal.

<p align="center">
  <img src="docs/capturas/cliente-pago-en.webp" width="200" alt="English">
  <img src="docs/capturas/cliente-pago-fr.webp" width="200" alt="Français">
  <img src="docs/capturas/cliente-pago-pt.webp" width="200" alt="Português">
</p>

Siempre abre en español. El cliente puede cambiar a inglés, francés o
portugués, y la página lo recuerda esa noche (12 horas).

### 3. El saldo: la ficha OxioCard

<p align="center">
  <img src="docs/capturas/tarjeta-oxiocard.webp" width="300" alt="Ficha OxioCard">
</p>
<p align="center">
  <img src="docs/capturas/05-recepcion-nfc.webp" width="49%" alt="Recepción: acerca la ficha">
  <img src="docs/capturas/06-recepcion-cargado.webp" width="49%" alt="Recepción: saldo cargado">
</p>
<p align="center">
  <img src="docs/capturas/cliente-saldo.webp" width="260" alt="El saldo del cliente">
  &nbsp;&nbsp;
  <img src="docs/capturas/cliente-recarga.webp" width="260" alt="Recargar desde el móvil">
</p>

En recepción se carga saldo, en efectivo o con tarjeta, en una ficha NFC.
Dentro, se paga acercándola, sin PIN hasta un tope y con PIN o Face ID por
encima. El cliente ve su saldo y sus movimientos, y recarga desde el móvil.
Al salir, se le devuelve lo que no ha gastado.

### 4. Copa con invitación

<p align="center">
  <img src="docs/capturas/07-invitacion.webp" width="70%" alt="Copa con invitación">
</p>

Un cliente invita a una copa a una chica: se cobra con QR o con la ficha, y la
parte de la chica va a su cuenta aunque la cobre otra persona.

### 5. El dueño lo ve todo

<p align="center">
  <img src="docs/capturas/08-mapa-del-dinero.webp" width="49%" alt="Mapa del dinero">
  <img src="docs/capturas/09-cierre-z.webp" width="49%" alt="Cierre de la noche y Z">
</p>
<p align="center">
  <img src="docs/capturas/panel-cobros.webp" width="85%" alt="Cobros con código y referencia del banco">
</p>

- **Mapa del dinero:** ventas, lo que es del local, propinas y cobros de la noche, en vivo.
- **Cobros:** cada uno con su código de confirmación y su referencia del banco (pedido y autorización de BBVA), con buscador y exportación a CSV.
- **Cierre de la noche:** arqueo de caja por pasos y el Z para la gestoría.
- **Avisos e incidencias:** pagos sin confirmar, cobros dobles, devoluciones…

### 6. La liquidación de OxioPay

<p align="center">
  <img src="docs/capturas/liquidacion.webp" width="70%" alt="Liquidación OxioPay">
</p>

Cada semana (de lunes 08:00 a lunes 08:00, hora de Madrid) el sistema calcula
lo que el local debe a OxioPay: la comisión del servicio, menos lo devuelto, y la comisión de plataforma del saldo cargado sin ella.
Sale con su referencia de transferencia, su desglose por concepto y por noche,
y en PDF y CSV. El super-admin apunta los pagos con 2FA.

---

## Qué hace

| Área | Funciones |
|---|---|
| **Cobrar** | Cobro único con QR + NFC · carta por secciones · propinas · comisión del servicio por local · datáfono PAX (Paytef) · TPV en barra |
| **Saldo (OxioCard)** | Fichas NFC · carga en recepción (efectivo y tarjeta) · recarga desde el móvil · PIN y Face ID (passkeys) · tope sin PIN por noche · pase de Google Wallet · devolución al salir |
| **Personal** | App de las chicas y del personal · comisiones por sección · «Mis cobros» · pagos a las chicas · invitaciones |
| **Dueño** | Mapa del dinero · cobros con referencia del banco · noches y cierre con Z · informes y CSV para la gestoría · devoluciones de BBVA · cuadre con el banco · «Por aprobar» con 2FA · avisos |
| **OxioPay** | Consola del super-admin: negocios, locales, pausa, comisión por local · liquidación semanal |
| **Cliente** | Páginas de pago en 4 idiomas · justificante · saldo y movimientos |

## Cómo está hecho

```mermaid
flowchart LR
    subgraph Moviles["Móviles y pantallas"]
        OP["App del personal<br/>(Next.js)"]
        AD["Panel del dueño y consola<br/>(Next.js)"]
        TPV["TPV<br/>(Next.js)"]
        PAX["Datáfono PAX<br/>(Android)"]
        CL["Cliente<br/>(/pay, /w, /s, /c)"]
    end
    API["API<br/>NestJS + Fastify"]
    DB[("PostgreSQL 16<br/>con RLS por local")]
    RD[("Redis<br/>colas BullMQ")]
    GW["Pasarelas<br/>Redsys/BBVA · Paytef · Peanpe · Cecabank"]
    OP & AD & TPV & PAX & CL --> API
    API --> DB
    API --> RD
    API <--> GW
```

| Pieza | Tecnología |
|---|---|
| API | NestJS 11 + Fastify, Prisma 5, zod 4, BullMQ, Socket.IO (tiempo real) |
| Base de datos | PostgreSQL 16 con seguridad por filas (RLS) para separar los locales |
| Apps | Next.js 15 + React 19 (`admin`, `operator`, `tpv`, `web-client`) y Android (`pax-android`) |
| Infraestructura | Docker, desplegado con Dokploy; copias de la base en Cloudflare R2 |
| Calidad | GitHub Actions: lint, tipos, pruebas unitarias, integración con Postgres real, e2e con Playwright, build de Docker y orden de migraciones |

### Seguridad

- **Cada local ve solo lo suyo**: hoy lo filtra el código en cada consulta. Además, la base tiene seguridad por filas (RLS):
  - **con `FORCE`** en 12 tablas: saldos y sus consumos, ganancias y pagos de las chicas, «Por aprobar», efectivo, líneas de cada cobro y liquidación de OxioPay;
  - **sin `FORCE`** de momento en `payments`, `payment_events`, `refunds`, `users` y `terminals`, entre otras.

  La RLS solo actúa cuando el API entra con un usuario sin superusuario. El cambio está preparado y probado, pero aún no está activado: ver [`DB-ROLE.md`](nightpay/docs/DB-ROLE.md).
- **2FA (TOTP)**:
  - **obligatoria** para el super-admin, para aprobar en «Por aprobar», para que el encargado pague a una chica y en lo más delicado del efectivo (anular una recarga, devoluciones grandes en recepción, cambiar el fondo al cerrar la noche);
  - **si la tiene activada**, en el resto de lo que mueve dinero del dueño: pagar a una chica, cambiar reglas del local o cuentas de cobro. Conviene activarla.
- **Avisos de los bancos firmados** y comprobados antes de dar un pago por cobrado: nada se da por pagado sin prueba.
- **Secretos fuera del repo** (`.env`), revisor de secretos antes de cada commit (`scripts/check-secrets.py`) y auditoría de dependencias en el CI.

## El repo

```
nightpay/
├── apps/
│   ├── api/           API y páginas del cliente
│   ├── admin/         panel del dueño y consola del super-admin
│   ├── operator/      app de las chicas y del personal
│   ├── tpv/           TPV de barra
│   ├── web-client/    web del cliente (Next.js)
│   ├── pax-android/   app del datáfono PAX
│   └── e2e/           pruebas de punta a punta (Playwright)
├── packages/
│   ├── contracts/     tipos y validación compartidos (zod)
│   ├── db/            Prisma: esquema, migraciones y CLI de operación
│   ├── ui/            componentes de interfaz
│   └── api-client/    cliente del API para las apps
└── docs/              documentación
```

## Empezar

- **En local:** [`nightpay/README.md`](nightpay/README.md), [`nightpay/SETUP.md`](nightpay/SETUP.md) y [`PUESTA-EN-MARCHA.md`](nightpay/docs/PUESTA-EN-MARCHA.md).
- **Desplegar:** [`DEPLOYMENT.md`](nightpay/docs/DEPLOYMENT.md) y [`DOKPLOY-STEPS.md`](nightpay/docs/DOKPLOY-STEPS.md). Publicar es fusionar en `main` y desplegar en Dokploy: primero el API y después las apps.
- **Operación:** [`SUPERADMIN.md`](nightpay/docs/SUPERADMIN.md) (consola, comisión, liquidaciones), [`BACKUPS.md`](nightpay/docs/BACKUPS.md) (copias), [`DB-ROLE.md`](nightpay/docs/DB-ROLE.md) (usuario de la base sin superusuario), [`APROBACIONES.md`](nightpay/docs/APROBACIONES.md), [`DATAFONO-SALDO.md`](nightpay/docs/DATAFONO-SALDO.md), [`GOOGLE-WALLET.md`](nightpay/docs/GOOGLE-WALLET.md).
- **Pasarelas:** [`PAYTEF-INTEGRATION.md`](nightpay/docs/PAYTEF-INTEGRATION.md) y [`PEANPE-INTEGRATION.md`](nightpay/docs/PEANPE-INTEGRATION.md).

---

## Los otros proyectos

Este repo es solo OxioPay. Lo que estuvo aquí antes vive en su propio repo
(privado), con su historial:

| Repo | Qué era aquí |
|---|---|
| `maxxag-wa-ops` | `chatbot_maxxag/`: WhatsApp y Sara bot. La línea de aquí está en la rama `desde-first-tries`. |
| `sistema-atm` | `sistema_atm.html`, `manual_browser/`, los scripts y datos de cajeros de `otros/`, los `.bat` y el README antiguo |
| `herramientas` | `whatsapp_analyzer/`, `otros/peanpe-automation/`, `otros/peanpe_bot.py`, `scripts/check-secrets.py` |
| `ventas` | `ventas/` |
