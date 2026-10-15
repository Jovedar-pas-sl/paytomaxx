# Checklist: Onboarding de un local nuevo en NightPay

**Objetivo**: que un local (discoteca/bar/festival) esté operativo en **menos de 1 hora**, desde cero hasta primer cobro real.

**Responsable**: Manager comercial + ingeniero on-call (primera vez).

---

## Prerrequisitos (antes de llegar al local)

- [ ] Contrato firmado por el owner
- [ ] Datos bancarios recibidos (para pasarela)
- [ ] Proveedor de pasarela decidido (Wipay o Peanpe)
- [ ] Credenciales de pasarela recibidas del partner (API key + secret + merchant ID)
- [ ] Lista de datáfonos físicos del local (marca, modelo, IDs externos)
- [ ] Acceso SSH/admin al servidor NightPay
- [ ] Tablet(s) preparadas con app TPV instalada (web PWA)

---

## Fase 1 — Creación del tenant (5 min)

### En admin dashboard

- [ ] Login como `OWNER` global con cuenta admin@nightpay.app
- [ ] Menú **Venues > Crear nuevo venue**
- [ ] Rellenar:
  - Nombre del local (ej. "Discoteca Luna, Valencia")
  - Slug URL-friendly (ej. `luna-vlc`)
  - Zona horaria (default `Europe/Madrid`)
  - Dirección postal (para receipts)
- [ ] **Guardar** → anotar el `venue_id` devuelto

### Verificación

```bash
# debe aparecer en listado
curl https://api.nightpay.app/v1/venues \
  -H "Authorization: Bearer $OWNER_JWT" | jq '.[] | select(.slug=="luna-vlc")'
```

---

## Fase 2 — Configurar credenciales de pasarela (10 min)

- [ ] En admin, dentro del venue creado, ir a **Configuración > Pasarela**
- [ ] Seleccionar proveedor (Wipay / Peanpe)
- [ ] Introducir credenciales (API key, secret, merchant ID)
  - **Las credenciales se cifran en DB con AES-256-GCM automáticamente**
- [ ] Marcar como `Activa`
- [ ] **Guardar**

### Test de credenciales

- [ ] Botón "Probar conexión" → debe devolver `{ status: 'ok', merchant: '...' }`
- [ ] Si falla: ver runbook `docs/runbooks/P0-pasarela-caida.md` sección "credenciales"

### (Opcional) Segunda pasarela para fallback

- [ ] Añadir segunda credencial con otro proveedor
- [ ] NightPay usará fallback automático si la primaria abre circuit breaker (ADR-005)

---

## Fase 3 — Registrar terminales / datáfonos (10 min)

Por cada datáfono físico del local:

- [ ] **Terminales > Nuevo terminal**
- [ ] Rellenar:
  - Label humano (ej. "Barra 1", "Pista central")
  - External ID (el ID que el proveedor de pasarela usa — normalmente impreso en el datáfono o en el panel del proveedor)
  - Marca / modelo (informativo)
- [ ] **Guardar**
- [ ] Repetir hasta tener todos (normalmente 3–6 por venue mediano)

### Verificación

```sql
SELECT id, label, external_id, active FROM terminals
WHERE tenant_id = '<venue_id>';
```

---

## Fase 4 — Crear usuarios del venue (10 min)

Perfiles típicos:
- 1 **Owner** (dueño del local; rol `OWNER` restringido a este venue)
- 1–2 **Managers** (encargados, pueden hacer reembolsos)
- 3–10 **Waiters** (camareros, solo crean cobros)

Para cada uno:

- [ ] **Usuarios > Invitar usuario**
- [ ] Email + rol
- [ ] Click "Enviar invitación" → recibe email con magic link + contraseña temporal
- [ ] Usuario cambia contraseña al primer login
- [ ] Manager/Owner: configurar 2FA TOTP (obligatorio para refunds >100€)

### Verificación

- [ ] Cada usuario puede hacer login en admin (Manager/Owner) o TPV (Waiter)
- [ ] Waiter NO ve botón "Reembolsar" en UI
- [ ] Manager VE el botón; si clica y el monto >100€ → pide código TOTP

---

## Fase 5 — Test de pago real de 1€ (15 min)

**No saltarse este paso**. Detecta 90% de problemas de configuración.

### En el local, con un terminal operativo

- [ ] Encender el datáfono
- [ ] En la tablet TPV: login como waiter
- [ ] Introducir importe `1.00€`
- [ ] Seleccionar terminal correcto
- [ ] Click "Cobrar" → se genera QR
- [ ] Con un móvil propio: escanear QR
- [ ] En móvil aparece página de pago → "Acerca tarjeta al datáfono"
- [ ] Acercar tarjeta/móvil al datáfono del local
- [ ] **Verificar**:
  - [ ] TPV muestra "Cobrado 1,00€" + sonido
  - [ ] Móvil muestra "Pago completado ✓"
  - [ ] Latencia total < 15s (cronómetro en mano)
  - [ ] Dashboard admin muestra el pago en estado AUTHORIZED

### Si falla

Consultar `docs/runbooks/P0-pagos-atascados.md` — el pago se queda en AUTHORIZING si webhook no llega.

---

## Fase 6 — Test de reembolso (5 min)

- [ ] En admin, buscar el pago de 1€ recién creado
- [ ] Click "Reembolsar" → total
- [ ] Confirmar
- [ ] Verificar:
  - [ ] Estado cambia a REFUNDED
  - [ ] La tarjeta recibe la devolución (revisar app bancaria; algunos bancos tardan 24h)

---

## Fase 7 — Training del personal (10 min)

### Owner/Manager (5 min)

- [ ] Ver dashboard y filtros
- [ ] Saber hacer reembolso parcial/total
- [ ] Saber exportar CSV para el contable
- [ ] Conocer número de emergencia soporte NightPay
- [ ] Familiarizado con cierre de caja (cada noche, click "Cerrar día")

### Camareros (5 min × por camarero)

- [ ] Mostrar: pantalla TPV, cómo introducir importe
- [ ] Mostrar: QR se genera, cliente escanea
- [ ] Mostrar: qué hacer si QR expira (botón "Nuevo")
- [ ] Mostrar: qué hacer si pago tarda (esperar 30s, si no completa — llamar manager)
- [ ] **NO** deben intentar hacer reembolsos (no tienen permiso)
- [ ] Explicar al camarero el TPV en el propio local (aún no hay chuleta impresa)

---

## Fase 8 — Go-live supervisado (primera noche)

- [ ] El ingeniero on-call queda disponible en Telegram la primera noche del venue
- [ ] Bot NightPay monitoriza métricas del venue específicamente
- [ ] Alertas P0/P1 del venue van con etiqueta `[venue=luna-vlc]` a grupo interno
- [ ] Revisión a las 06:00 AM: cuántos pagos, cuántos atascados, cuántos refunds
- [ ] Postmortem de primera noche (incluso si todo bien) para detectar mejoras

### Después de la primera noche

- [ ] Verificar reconciliación diaria a las 07:00 → estado `OK`
- [ ] Enviar resumen al owner: "Primera noche: N pagos, €X bruto, €Y refunds, 0 incidentes"

---

## Checklist resumen por responsable

### Ingeniero on-call
- [ ] Credenciales verificadas
- [ ] Test pago 1€ completado
- [ ] Test refund completado
- [ ] Reconciliación D+1 verde

### Manager comercial
- [ ] Contrato firmado en histórico
- [ ] Usuarios creados con roles correctos
- [ ] Training camareros realizado

### Owner del local
- [ ] Familiarizado con dashboard
- [ ] Conoce cómo hacer refund
- [ ] Sabe cómo contactar soporte

---

## Timeline esperado

| Fase | Tiempo | Acumulado |
|------|-------:|----------:|
| Prerrequisitos | (antes) | 0 min |
| 1. Crear tenant | 5 min | 5 min |
| 2. Credenciales pasarela | 10 min | 15 min |
| 3. Terminales | 10 min | 25 min |
| 4. Usuarios | 10 min | 35 min |
| 5. Test pago 1€ | 15 min | 50 min |
| 6. Test refund | 5 min | 55 min |
| 7. Training personal | 10 min | 65 min |

**Total**: ~1h. Si excede 90 min sin completar, hay un problema — revisar cuál fase se atascó.

**Fase 8 (go-live supervisado)** se extiende a la noche siguiente, no se cronometra aquí.
