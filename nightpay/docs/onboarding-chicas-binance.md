# Onboarding manual de operadoras a Binance + NightPay

**Para uso interno de admin/manager del venue. v1 · 2026-05**

Este es el proceso paso a paso cuando das de alta a una chica nueva. Tiempo total: **~30 min con la chica delante** + 24h de espera por la verificación KYC de Binance.

---

## Material que necesitas tener antes de empezar

- [ ] El móvil de la chica (Android o iPhone, da igual; cualquiera con cámara y datos).
- [ ] Su **pasaporte vigente** (físico, no foto de pasaporte).
- [ ] **Un papel y boli** para apuntar la address que te dará Binance.
- [ ] Tu portátil con NightPay admin abierto en `https://admin.paytomaxx.com` (o `http://localhost:4103` en dev).
- [ ] **Email de la chica** funcional (puede ser Gmail recién creado si no tiene).
- [ ] **Su número de teléfono español** (o el de origen — Binance acepta cualquiera).

---

## Paso 1 — Crear la chica en NightPay (5 min)

Antes de tocar Binance, das de alta a la chica en NightPay para que tenga su login.

### Opción A — desde el admin (web)

1. `https://admin.paytomaxx.com` → login con tu cuenta OWNER.
2. Tab **Operadoras** → botón "Nueva operadora".
3. Rellena:
   - **Email**: el de la chica (no inventes — irá un link de activación)
   - **Display name**: su nombre como aparecerá en el sistema (ej. "Camila")
   - **Comisión**: 90 (el default modelo NightPay)
4. Pulsa "Crear".
5. Aparece un **link de activación de 24h** — cópialo.

### Opción B — desde la terminal (más rápido si das de alta varias)

```bash
cd ~/nightpay
pnpm cli create-operator \
  --venue luna-vlc \
  --email camila@example.com \
  --display-name "Camila" \
  --commission 90
```

El comando imprime la URL de invite. Cópiala.

### Activar la cuenta de la chica

1. Manda el link a su WhatsApp o pásaselo en mano.
2. Que lo abra en el móvil → pantalla "Activar cuenta" en NightPay operator.
3. Le pide una contraseña — que ponga una que recuerde (mínimo 8 caracteres).
4. **Apúntate la contraseña en un papel inicialmente** — luego ella podrá cambiarla.

---

## Paso 2 — Abrir Binance con su pasaporte (10 min activo + 24h espera)

### Registro inicial

1. En el móvil de la chica → instalar app **Binance** (Play Store / App Store).
2. Abrir app → **Registrarse** → con su email.
3. **País de residencia**: España (no su país de origen — Binance evalúa según residencia actual).
4. Crear contraseña fuerte.
5. **Verificar email** — recibirá un código.
6. **Verificar móvil** — recibirá un SMS.

### Verificación de identidad (KYC) — esto es lo importante

1. En la app: **Perfil → Verificación de identidad**.
2. Selecciona **Verificación intermedia** (suficiente para recibir/enviar cripto).
3. Tipo de documento: **Pasaporte**.
4. País emisor: el de su pasaporte (Colombia, Venezuela, Argentina, Brasil, etc.).
5. **Foto del pasaporte**: foto frontal nítida — sin reflejos, todo el documento visible.
6. **Selfie liveness**: la app le pedirá hacer una selfie + girar la cabeza siguiendo instrucciones (proof of life).
7. Datos:
   - Nombre y apellidos **EXACTOS como en el pasaporte** (con tildes y todo).
   - Fecha de nacimiento.
   - Dirección — puede usar el domicilio del venue/casa donde se aloja si tiene empadronamiento. Si no, una dirección razonable de la ciudad.

8. Pulsa **Enviar**.

### Tiempos esperados

- Aprobación normalmente en **2 a 24 horas**.
- Recibe email/notificación push cuando esté lista.
- Si Binance rechaza → ver sección "Troubleshooting" abajo.

---

## Paso 3 — Mientras Binance verifica: opcional, activar Visa Card (5 min)

La Binance Visa Card es **gratis** y permite que la chica gaste su USDT en cualquier comercio como una tarjeta normal.

1. En la app Binance → **Tarjeta** (icono de tarjeta en el menú).
2. Solicitar tarjeta virtual (la física tarda 5-10 días en llegar por correo).
3. La virtual está activa al momento → la chica puede usarla en Apple Pay / Google Pay desde el primer minuto.

---

## Paso 4 — Obtener su address USDT-TRC20 (2 min)

Cuando Binance haya verificado:

1. En la app Binance → **Wallet → Spot** → buscar **USDT**.
2. Pulsar **Depositar** sobre USDT.
3. **Selecciona red**: ⚠️ **TRC20** (también llamado TRX o Tron) — NO BEP20 ni ERC20.
   - **Por qué TRC20**: la red Tron tiene fees de ~0.5 €/tx. BEP20 también es barata pero menos universal. ERC20 sería ~5-20 € (carísimo para nuestro caso).
4. Aparecerá una address que empieza con **T...** (34 caracteres, ej. `TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV`).
5. **Pulsa Copiar** y mándatela a tu propio WhatsApp.
6. **Validación visual**: la address debe empezar por `T` mayúscula y tener exactamente 34 caracteres.

### ⚠️ Errores comunes que cuestan dinero

| Error | Consecuencia |
|---|---|
| Copias address ERC20 (empieza con `0x`) | Mandas USDT a la red Ethereum → fees 10-20€ → puede perderse |
| Copias address BEP20 (también empieza con `0x`) | Mandas USDT a Binance Smart Chain → barato pero hay que asegurar que la chica eligió BEP20 en su Wallet también |
| Copias address mal (carácter cambiado) | Los fondos se pierden permanentemente — no hay reverso |

**Regla de oro**: tú copias la address en tu portátil → pegas en NightPay → haces un envío de prueba de 1 USDT primero → la chica confirma que llegó → solo entonces envías más.

---

## Paso 5 — Registrar la address en NightPay (1 min)

### Opción A — desde admin web

1. `https://admin.paytomaxx.com` → tab **Operadoras** → click en Camila.
2. Tab **Editar** → bajar a "Routing del payout".
3. **Método de payout**: `USDT — Tron (TRC20) · default Binance`.
4. **Address**: pega la `T...` que apuntaste.
5. **Alias**: "Binance Camila" (o lo que quieras que aparezca en tu lista).
6. **Guardar**.

### Opción B — desde terminal (más rápido si setteas varias chicas)

```bash
cd ~/nightpay
pnpm cli set-operator-payout \
  --email camila@example.com \
  --method USDT_TRC20 \
  --address TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV \
  --label "Binance Camila"
```

---

## Paso 6 — Prueba de envío con 1 USDT (5 min)

Antes de operar en serio, **siempre** haz una prueba pequeña.

1. Desde la app Binance del **venue admin** (la cuenta business del local, no la de la chica).
2. **Wallet → Spot → USDT → Retirar**.
3. Red: **TRC20**.
4. Address: pega la de Camila.
5. Cantidad: **1 USDT** (suficiente para confirmar que llega).
6. Envía.
7. En 3-5 minutos Camila debería ver +1 USDT en su Binance.
8. Si **NO** llega en 15 min:
   - Verifica el hash de la transacción en https://tronscan.org → pega el txhash → confirma que la red es Tron y la address destino es correcta.
   - Si la tx aparece en Tron y la address es correcta → contactar soporte Binance de Camila (la wallet de ella podría estar en revisión KYC).

---

## Paso 7 — Documentar todo

Por cada chica, mantén un registro físico/digital:

| Campo | Ejemplo |
|---|---|
| Nombre legal | Camila Rodríguez Pérez |
| Display name en NightPay | Camila |
| Email | camila@example.com |
| Móvil | +34 6XX XX XX XX |
| País origen pasaporte | Colombia |
| Pasaporte número (últimos 4) | ...8742 |
| Comisión asignada | 90% |
| Binance email | igual o distinto del de NightPay |
| Address USDT-TRC20 | TXYZ...UFiV |
| Fecha onboarding | 11/05/2026 |
| Test 1 USDT enviado | ✅ confirmado el 12/05/2026 |

Guarda este registro **cifrado o en armario físico** — no en Drive público.

> **Atajo NightPay**: todos estos campos también se pueden registrar dentro del admin
> en `Operadoras → Click chica → tab "Onboarding"`. El form tiene checkbox "Prueba 1 USDT
> confirmada" que guarda fecha+hora automática + flags "necesita ayuda con wallet/docs"
> para detectar las que están atascadas. Es **el sitio canónico** — el papel solo es backup.

---

## Troubleshooting

### Binance rechaza el KYC

Causas más comunes:

1. **Foto del pasaporte con reflejos / borrosa** → repetir con mejor luz.
2. **Selfie no coincide con la foto del pasaporte** → repetir selfie sin maquillaje excesivo, mismo ángulo.
3. **País sancionado** → pasaporte de país que Binance no acepta (Cuba post-2024, Corea del Norte, etc.). Mira la lista actualizada en Binance.
4. **Pasaporte caducado o casi caducado** (menos de 6 meses) → Binance lo rechaza.

Si pasa esto → ir a la **alternativa Bybit** (acepta perfiles ligeramente más laxos) o **OKX**. Mismo flow, distinta app.

### La chica no recibió el email de NightPay

- Reenviar el invite manualmente: en admin, click en la chica → "Reenviar invitación" (si está implementado) o:
- Generar nuevo invite via CLI: `pnpm cli create-operator ...` con su email — el sistema crea un token nuevo de 24h. Si el email ya existe, borrar primero con SQL (avísame y lo hago).

### La chica perdió la contraseña de NightPay

- Por ahora no hay flujo "reset password" implementado. Solución manual:
  - Borrar a la chica con SQL bypass.
  - Crear de nuevo con el mismo email → recibe invite → pone contraseña nueva.
  - Sus earnings históricos **se pierden** en este flow (porque tenían su userId antiguo) — alternativa: actualizar su passwordHash directo con bcrypt.

### Envié USDT a la red equivocada (BEP20 en vez de TRC20)

- Los fondos pueden recuperarse si la chica tiene wallet BEP20 también activa en Binance — la app a veces detecta el chain mismatch y permite hacer "transfer between wallets".
- Si no → contactar soporte Binance con el txhash. Tarda 1-2 semanas y a veces no se recupera.
- **Prevención**: en cada envío, verifica TRES VECES que la red es TRC20 antes de pulsar enviar.

### Volumen alto: Binance pide KYC reforzado

- Cuando una cuenta recibe >10.000 USDT/mes, Binance puede pedir documentación adicional (factura, contrato laboral, etc.).
- Para tu caso (chicas con commisiones de 200-500 €/noche), tardará meses en aparecer este escenario.
- Cuando aparezca: la chica aporta el contrato freelance con el venue + factura mensual. Suficiente.

---

## Checklist resumido por chica

- [ ] Crear en NightPay (admin o CLI) + capturar invite URL
- [ ] Chica activa cuenta NightPay (pone contraseña)
- [ ] Chica registra Binance + envía pasaporte para KYC
- [ ] Esperar verificación Binance (2-24h)
- [ ] Chica obtiene address USDT-TRC20 (red Tron)
- [ ] Admin pega address en NightPay (admin UI o CLI)
- [ ] Admin envía prueba 1 USDT desde Binance business venue
- [ ] Chica confirma recepción del 1 USDT
- [ ] Lista para operar

Una vez completado para una chica, el flow operativo es:
- Ella cobra clientes via QR en NightPay → comisión acumula automáticamente.
- Cada semana/mes el admin marca "pagado" desde NightPay → admin envía X USDT desde su Binance business al address de la chica → admin pega txhash en NightPay → auto-verifica en Tronscan → status MATCHED.

---

## FAQ que las chicas suelen preguntar

**P: ¿Tengo que pagar impuestos en España por lo que cobre en USDT?**
R: Si vives >183 días/año en España, sí. Es ingreso gravable. Tu contable lo declara como rendimiento de actividad económica autónoma. Si tu saldo cripto a 31/dic supera 50.000 €, además presentas Modelo 721. NightPay no te retiene nada — tú gestionas tu fiscalidad. Te damos certificado mensual con los pagos hechos para que se lo pases al contable.

**P: ¿Puedo gastar mi saldo USDT como un sueldo normal?**
R: Sí, con la tarjeta Binance Visa puedes pagar en cualquier comercio EU. La conversión USDT → EUR la hace Binance automática al gastar, con spread ~0.1%.

**P: ¿Mi familia en mi país puede recibir el USDT?**
R: Sí. Tú mandas USDT desde Binance a su wallet (Binance también en LatAm, o Lemon/Bitso/MercadoPago según país). Ellos lo cambian a moneda local con P2P o exchange local. Pregúntales por su address antes — y haz prueba de 1 USDT primero igual que arriba.

**P: ¿Qué pasa si pierdo mi móvil?**
R: Tienes que tener guardada la **frase de recuperación de Binance** en un lugar seguro (papel + caja fuerte/banco, no en el móvil). Sin ella perdiste el dinero. Recuérdale a la chica que **NUNCA** comparta esa frase con nadie — ni con el admin del venue, ni con soporte Binance.

---

## Apéndice A — Si Binance no acepta a la chica

Orden de fallback (probar en este orden):

### A1. Bybit + Bybit Card
- Casi mismo flow que Binance. KYC online ~24h.
- App: bybit.com / Bybit en App Store
- Acepta pasaportes que Binance a veces rechaza (Cuba pre-2024 ej.)
- Address USDT-TRC20: igual concepto, `Deposit → USDT → Tron (TRC20)`
- En NightPay: `payoutMethod = USDT_TRC20`, `walletProvider = BYBIT`

### A2. OKX + OKX Card
- Soporte español sólido. KYC similar.
- App: okx.com
- En NightPay: `payoutMethod = USDT_TRC20`, `walletProvider = OKX`

### A3. KuCoin (sin KYC tier 1)
- Permite operar con límites bajos sin KYC formal.
- Útil si la chica no quiere subir pasaporte por miedo a "trazabilidad".
- Limitación: depósitos/retiros con tope mensual.
- En NightPay: `payoutMethod = USDT_TRC20`, `walletProvider = OTHER` + nota "KuCoin no-KYC".

### A4. Trust Wallet self-custody
- Cero KYC, control total. Riesgo: si la chica pierde la seed phrase, perdió todo.
- Flow:
  1. Chica instala Trust Wallet desde Play Store / App Store.
  2. Crea wallet → **escribe la seed phrase de 12 palabras en PAPEL**.
  3. Tap "Receive" → "USDT" → red "Tron (TRC20)" → copia address.
  4. En NightPay: `payoutMethod = USDT_TRC20`, `walletProvider = TRUST_WALLET`, address pegada.
- Pega "para gastar el USDT": tiene que vender P2P (LocalCryptos / Binance P2P como contraparte).

### A5. Solo es-wallet (sin cripto)
- Si la chica rechaza cripto por completo.
- Opciones: **FasterPay**, **PayQuicker**, **Hyperwallet** (Phase 1 plan documenta detalles).
- Flow es manual: admin envía via web del e-wallet, pega receipt ID en NightPay, marca MANUAL_OK.
- En NightPay: `payoutMethod = FASTERPAY_EMAIL` (o el correspondiente) + email de la chica como address.

### A6. Wallet local LatAm (chica de viaje a su país)
- Si vive temporalmente en su país de origen.
- AR/UY/PE → MercadoPago, BR → Pix, CO → Nequi/Daviplata, MX → Bitso.
- En NightPay: `payoutMethod = MERCADOPAGO_CVU` (o el que aplique).
- Reconciliación es **manual** — admin pega referencia de la transferencia local.

---

## Apéndice B — Templates de WhatsApp / mensajes a la chica

### B1. Mensaje inicial (tras crearla en NightPay)

```
Hola [Nombre], soy [tu nombre] de [Venue].
Te he creado tu cuenta en el sistema de cobros que usamos.
Para activarla y elegir tu contraseña, abre este link (caduca en 24h):

[URL_DE_INVITE]

Cuando lo tengas listo, hablamos para configurar Binance que es donde te llegarán tus comisiones.
```

### B2. Antes de la cita Binance (1 día antes)

```
Hola [Nombre], mañana a las [hora] hacemos lo de Binance.
Trae:
- Tu pasaporte vigente (no caducado, no menos de 6 meses)
- Tu móvil cargado
- 5 minutos de paciencia para hacer el selfie 😄

Tarda 30 min con nosotros y luego Binance verifica en 2-24h.
```

### B3. Tras configurar address en NightPay

```
Lista [Nombre], ya estás operativa.
Tu address de cobro: TXYZxQwUVqHbvHvgrkqz6T6oyhqcKpuFiV
Te voy a mandar 1 USDT de prueba — confírmame en cuanto te llegue (suele ser instant pero a veces tarda 5 min).
```

### B4. Pago mensual / semanal

```
Hola [Nombre], te he pagado [X] USDT por las comisiones de [periodo].
TxHash: 0xabc123...
Verifica en tu Binance que llegó. Si en 30 min no aparece avísame.
```

---

## Apéndice C — Mantener la lista de chicas que necesitan ayuda

En el admin: tab Operadoras → toggle "Solo las que necesitan ayuda".

Te aparecen las que tienen marcado:
- `needsHelpWallet` — no entiende cripto, KYC rechazado, etc.
- `needsHelpDocs` — falta empadronamiento, NIE en trámite, etc.

Filas en amarillo = pendiente. Tu objetivo cada semana: bajar ese contador.

Estado `onboardingStatus` para saber dónde está cada una:
- ⚪ **NEW** — recién creada en el sistema, sin invite
- 🟡 **PROFILE_CREATED** — invite enviado, no aceptado
- 🟠 **INVITE_ACTIVATED** — cuenta NightPay con password, pero sin wallet
- 🔵 **BINANCE_PENDING** — KYC en proceso
- 🟢 **READY** — operativa, puede cobrar y recibir
- 🔴 **BLOCKED** — algún problema sin resolver (notas describen)
