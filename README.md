# OxioPay

Cobro con QR, saldo y datáfono para ocio nocturno: la app de las chicas y del
personal, el panel del dueño, el TPV, las páginas del cliente y el API.

Todo el código está en [`nightpay/`](nightpay/) (monorepo pnpm + turbo):

| Carpeta | Qué es |
|---|---|
| `nightpay/apps/api` | API (NestJS + Fastify, Prisma, Postgres, Redis/BullMQ) y las páginas del cliente (`/pay`, `/w`, `/s`, `/c`) |
| `nightpay/apps/admin` | Panel del dueño y consola del super-admin (Next.js) |
| `nightpay/apps/operator` | App de las chicas y del personal (Next.js) |
| `nightpay/apps/tpv` | TPV (Next.js) |
| `nightpay/apps/pax-android` | App del datáfono PAX |
| `nightpay/packages` | Contratos (zod), base de datos (Prisma y migraciones), UI y cliente del API |
| `nightpay/docs` | Documentación: despliegue, copias, base de datos, pasarelas… |

- Empezar: [`nightpay/README.md`](nightpay/README.md) y [`nightpay/SETUP.md`](nightpay/SETUP.md).
- Desplegar (Dokploy, desde la carpeta `nightpay/`): [`nightpay/docs/DEPLOYMENT.md`](nightpay/docs/DEPLOYMENT.md) y [`nightpay/docs/DOKPLOY-STEPS.md`](nightpay/docs/DOKPLOY-STEPS.md).
- CI: `.github/workflows/` (`nightpay-ci`, `nightpay-audit`, `pax-android`).
- Publicar = fusionar en `main` y desplegar en Dokploy (primero el API).

`scripts/check-secrets.py` y `.pre-commit-config.yaml` impiden subir secretos
(`pip install pre-commit && pre-commit install`).

## Los otros proyectos

Este repo es solo OxioPay. Lo que estuvo aquí antes vive ahora en su propio repo
(privado), con su historial:

| Repo | Qué era aquí |
|---|---|
| `maxxag-wa-ops` | `chatbot_maxxag/` (WhatsApp y Sara bot; la línea de aquí está en la rama `desde-first-tries`) |
| `sistema-atm` | `sistema_atm.html`, `manual_browser/`, los scripts y datos de cajeros de `otros/`, los `.bat` y el README antiguo |
| `herramientas` | `whatsapp_analyzer/`, `otros/peanpe-automation/`, `otros/peanpe_bot.py`, `scripts/check-secrets.py` |
| `ventas` | `ventas/` |
