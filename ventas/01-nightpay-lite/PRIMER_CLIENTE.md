# Primer cliente — perfil, guion, email y objecion clave

> Documento operativo de outreach. Plantillas reales para enviar esta semana.

---

## 1. Perfil ideal del primer cliente (ICP)

Filtros duros (TODOS deben cumplirse):

- Sala de ocio nocturno en Espana (no bar tarde, no restaurante).
- Aforo declarado **500-1.500 personas** (no nano, no estadio).
- **PAX A920 ya activo** en Paytef company `76861` (ver `shared_db.json`).
- `paytefDeviceStatus = "Conectado"` o `paytefLastConnection` <30 dias.
- Opera **minimo 3 noches/semana** (jueves-sabado).
- Ticket medio estimado >25 € por consumicion / pase.
- **No tiene caja moderna** (Excel, papel, sistema antiguo Hosteltactil/IGT viejo).
- Manager o duenoresponsable accesible (no franquicia con HQ en Madrid).

Filtros blandos (suma puntos):

- Cadena con 2-3 salas (potencial upsell Enterprise).
- Eventos privados / reservados (vende valor "aforo + cobro").
- Reciente cambio de gerencia (gerente nuevo = quiere modernizar).
- Activo en Instagram (campeon interno joven facil de encontrar).
- Ya usa Glovo / TheFork (familiarizado con SaaS B2B).

### Candidatos top desde `shared_db.json`

Sin inventar, los que aparecen con datos:

- **Club Royale Barra** (`4b7db6cd`) — RSR8 (PAX IM30) + RSR62 (PAX A920PRO Conectado).
- **Sala Kixx (V)** (`2039b081`) — RSR12 activo.
- Otros 50+ a filtrar segun criterios arriba.

> Marcar como **prospect prioritario** el que tenga `Conectado` reciente + nombre
> tipico de ocio nocturno (Club, Sala, Discoteca).

---

## 2. Guion de llamada qualifier (15 min)

> Objetivo: en 15 min decidir si pasa a demo (30 min) o no.

### Apertura (60 s)

> "Hola [NOMBRE], soy [TU_NOMBRE] de NightPay. Te llamo porque vi que [NOMBRE_SALA]
> trabaja con Paytef y vuestro PAX [A920 / IM30] esta activo. Tenemos software
> que se conecta directo sobre Paytef company 76861, sin tocar nada de lo que ya
> teneis. ¿Tienes 10 minutos para que te explique para que sirve?"
>
> **No** decir "que tal estas". **Si** decir "vi que [dato especifico]".
> Da senal de que no es spam ciego.

### Cualificacion (5 min, 5 preguntas)

1. "¿Cuantas noches abris a la semana ahora mismo?"
2. "Cuando cerrais caja al final de la noche, ¿cuanto tardais en saber el total
   real? ¿Tienes que llamar al banco al lunes?"
3. "Si te pregunto 'cuanto llevas vendido ahora mismo', ¿lo puedes saber en menos
   de 10 segundos sin abrir Paytef?"
4. "¿Como gestionais una devolucion cuando un cliente reclama un cobro de hace 3
   dias? ¿Quien autoriza?"
5. "¿Os ha pasado alguna vez que un camarero cobre dos veces a un cliente y no
   pudierais demostrarlo facilmente?"

> Si responde "ya tenemos software" → preguntar "cual" y "que te falla". Si dice
> "ninguno" o "Excel" → estas dentro.

### Pitch (3 min, no mas)

> "Lo que hacemos es darte 3 cosas sobre lo que ya tienes con Paytef:
>
> 1. **Una caja moderna** para tus camareros — cobran en 5 segundos, no en 25.
> 2. **Un panel para ti** — ves la noche en tiempo real desde el movil, sin
>    abrir nada raro.
> 3. **Una capa para el cliente** — el que escanea un QR en barra y paga sin
>    cola.
>
> No tocamos Paytef. Tu sigues con Paytef tal cual. Solo le sumamos software.
>
> Precio: setup unico 1.200 € (instalacion + formacion 2 h presencial) + 279 €/mes.
> Lo veras montado en 72 h desde que firmas. Te quedas atado solo 6 meses, luego
> 30 dias de aviso para cancelar.
>
> ¿Te gustaria ver una demo de 30 min esta semana?"

### Cierre llamada (1 min)

- Si "si" → **cerrar fecha demo AHORA** ("¿jueves 17:00 o viernes 11:00?").
- Si "necesito hablarlo" → "Te mando ahora mismo un dossier de 1 pagina y un
  video de 5 min con el flujo entero. ¿Cual es tu mejor email?"
- Si "no me interesa" → "Sin problema. ¿Conoces alguna sala que esto si le
  encajaria? Te invitamos a cenar si firmas referido."

---

## 3. Email de prospección (cold)

> Asunto: **Vi que [NOMBRE_SALA] usa Paytef — propuesta software 5 min**
>
> Hola [NOMBRE],
>
> Soy [TU_NOMBRE]. Sin rodeos: vi que [NOMBRE_SALA] tiene un PAX [A920 / IM30]
> activo en Paytef. Nosotros tenemos software que se conecta directo encima de
> esa misma cuenta Paytef sin tocar nada de lo que ya funciona.
>
> Lo que te damos:
>
> - **Panel admin** para que veas la venta de la noche en tiempo real desde el movil.
> - **TPV camarero** que cobra en 5 s en lugar de 25 (mismo PAX, mejor UX).
> - **Cobro QR cliente** en barra cuando haya cola (escanea, paga, sigue).
> - **Refunds con doble factor** para evitar discusiones con camareros.
>
> No cambia nada de tu Paytef. La comision Paytef es la misma. La instalacion
> son 72 h. La inversion: 1.200 € unico + 279 €/mes. Sin permanencia mas alla
> de 6 meses.
>
> Ya estamos integrados con la cuenta Paytef 76861 (la que comparten muchos
> operadores en Espana). El backend tiene 99 tests pasando y la infra esta en
> Hetzner UE con backups cifrados.
>
> ¿15 min esta semana para enseñartelo? Aqui mi calendario: [LINK_CAL].
>
> [TU_NOMBRE]
> NightPay · [MOVIL]
> nightpay.app
>
> PD: si no os encaja, ¿me podes decir el nombre de quien si en vuestro circulo?
> Pago la cena al que me presente al primer cliente.

### Variante WhatsApp follow-up (D+3 si no responde)

> Hola [NOMBRE], soy [TU_NOMBRE] de NightPay. Te mande email el [DIA] sobre
> software encima de vuestro Paytef. Sin compromiso — un video de 5 min:
> [LINK_LOOM]. Si no os encaja, te dejo en paz. Si si, 15 min cuando puedas.

---

## 4. Objeción esperada principal + respuesta

### La objeción real que vas a oir (no la de manual)

> "Mira, suena bien pero ahora mismo no tengo cabeza. Hablamos despues del verano."

(Traduccion: no es prioridad, no me has dado urgencia real, no quiero gastar
en algo nuevo.)

### Respuesta en 3 pasos

**1. Reconocer (no negar):**

> "Te entiendo perfectamente. Verano es el infierno de un manager de sala —
> nadie quiere cambiar nada en julio."

**2. Reframe del momento (sin atacar):**

> "Pero precisamente por eso te lo propongo ahora. Setup en 72 h **antes del
> 21 de junio** = arrancais el verano con la caja moderna. Si esperais a
> septiembre, perdeis 3 meses del trimestre mas fuerte sabiendo exactamente
> cuanto vendisteis cada noche."

**3. Reducir compromiso (escalon bajo):**

> "Te ofrezco Starter (199 €/mes) con compromiso solo **1 mes** en lugar de los
> 3 habituales. Empezamos el 15 de junio. Si en agosto no te ha aportado, lo
> paras sin penalizacion y te quedas con el set up funcionando para reactivar
> en septiembre si quieres. Coste total maximo si lo paras: 800 € setup +
> 199 € mes 1 = **menos de 1.000 €**. Eso es una mesa VIP buena, ¿no?"

### Si insiste con "septiembre":

> "Vale. Reservame ahora mismo una llamada para el 25 de agosto a las 11:00.
> Y mientras tanto te mando el video demo y un calendar invite. ¿Hecho?"
>
> (Mejor un calendar invite real que un "ya te llamare en septiembre".)

---

## 5. Senales de compra (cuando acelerar el cierre)

Escucha estas frases — si las dices tu cliente, pasa a propuesta YA:

- "¿Funciona con varios camareros a la vez?"
- "¿Y mi gestoria como cuadra esto?"
- "¿Cuando podrias empezar?"
- "¿Mi otro local en [CIUDAD] tambien?"
- "Tengo un sabado de boda privada el [FECHA], ¿llegais?"
- "¿Que necesitas de mi para empezar?"

Si oyes una de estas → **dejar de pitchear, enviar propuesta esta misma tarde**.

---

## 6. Senales de "no" silencioso (cuando no insistir)

- "Lo mira mi gestor" (3 veces seguidas) → no decide nunca, abandonar.
- "Voy a hablar con mi socio" sin fecha de seguimiento.
- No responde a 3 followups en 2 semanas.
- Pide "todos los precios y planes por escrito" antes incluso de demo.
- "Mi cunado lo programa gratis."

→ **Saludar, seguir con el siguiente**. El tiempo es el activo escaso.

---

## 7. Material que mandar tras la call qualifier

En el mismo email, todo junto:

1. **Dossier PDF** (versionar `pitch.md` a PDF con branding) — 1.5 MB max.
2. **Video Loom 5 min** demo en vivo del flujo completo.
3. **Link a `https://demo.nightpay.app`** con credenciales demo limitadas.
4. **Tarifa 1-pager** (extracto de `SALES.md` seccion 1).
5. **Confirmacion fecha demo** (calendar invite si ya cerrada).

> Si no se manda **dentro de las 4 h** post-call, baja a la mitad la probabilidad
> de cierre. Velocidad > perfeccion.
