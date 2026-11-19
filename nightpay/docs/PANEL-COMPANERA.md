# Panel de la compañera (19-nov-2026)

Lo que la compañera ve de su dinero en la app del personal. Qué cambia y cómo
se publica.

## Qué cambia

| Dónde | Qué |
|---|---|
| Ganancias → **Historial de ganancias** | Todas sus ganancias, noche a noche y con su hora (también lo ya pagado), de 50 en 50 con «Ver anteriores» y **«Buscar por fechas»**. Antes, solo las 50 últimas. |
| Ganancias → **Pagos recibidos** | Cada pago con su **referencia** y **«Ver justificante»** (solo enlaces `https`). «Ver todos los pagos»: todos, por páginas y con fechas. Antes, los 10 últimos y sin justificante. |
| Cobros | «Buscar por fechas». Con fechas no sale el total de «Esta noche». |
| Mi perfil (solo compañeras) | **Su cuenta de cobro, tapada**, con «Para cambiarla, pídeselo al encargado». No hay botón ni petición de cambio desde la app. |
| Mi perfil → «Avisarme cuando me paguen» | Cuando le apuntan un pago (en el panel o al aprobarlo en «Por aprobar»), su móvil recibe **«Te han pagado 37,50 €»**. Tocarlo abre Ganancias. El aviso no lleva ni el local ni la cuenta (sale en la pantalla bloqueada). |

- **Las fechas son noches de Madrid:** «del 1 al 15» va del día 1 a las 8:00 al
  día 16 a las 8:00 (como Ganancias y el cierre automático).
- **El aviso:**
  - Usa las mismas claves VAPID que el «Aviso en cada cobro» del cliente. Sin
    ellas, la app no lo ofrece y no se manda nada.
  - En el iPhone solo llega con la app añadida a la pantalla de inicio
    (iOS 16.4 o más); la app lo explica.
  - Un móvil avisa a una sola persona: si otra lo activa en ese móvil, pasa a ella.
  - Al «Salir», ese móvil deja de avisar. Al volver a entrar, se activa otra vez
    con un toque.
- **Fuera, por decisión del dueño (19-nov):** el resumen mensual o anual para
  imprimir y el CSV, y pedir el cambio de cuenta desde la app.

## Publicar

Va detrás de la cuenta de cobro segura (`docs/CUENTA-COBRO-SEGURA.md`): esa
primero.

1. **`nightpay-api`**. Al arrancar aplica la migración
   `20261119200000_aviso_pago_personal`: una tabla nueva
   (`staff_push_subscriptions`, con FORCE RLS). No toca nada que ya exista.
2. **`nightpay-operator-2`**. Hasta publicarla, la app anterior sigue igual: las
   listas de antes (`/operators/me/earnings` y `/operators/me/payouts`) no cambian.

Admin y tpv no cambian por esto.

Variables nuevas: **ninguna**. Para encender el aviso, las del «Aviso en cada
cobro» en `nightpay-api` (pendiente del traspaso):
`WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` y `WEB_PUSH_SUBJECT`.

Comprobar, con una compañera de prueba y las claves puestas: «Mi perfil» →
«Avisarme cuando me paguen» → marcar un pago en el panel → llega «Te han
pagado …».

## Dónde está

- API: `apps/api/src/modules/operators/my-history.ts` (páginas y fechas) y
  `staff-push.service.ts` (el aviso); los reintentos, compartidos con el aviso
  del cliente, en `wallets/charge-alert/push-sender.ts`.
- App: `components/EarningsDetail.tsx`, `PayoutsReceived.tsx`, `DateRange.tsx`,
  `PayoutProfile.tsx`, `lib/history.ts`, `lib/payout-push.ts` y el service
  worker `public/pago-sw.js`.
- Pruebas: `apps/api/test/integration/panel-companera.int.spec.ts`.
