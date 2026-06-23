# Widget Conversacional para Adult-Services

> Widget IA multi-idioma plug-and-play con catálogo, tarifas y handoff a WhatsApp. Especializado en webs de casas y clubes premium en España.

---

## El pitch en 30 segundos

Las webs de adult-services pierden el 60-80% de las consultas porque:

- El cliente entra a las 02:00 y nadie contesta en la web
- Recepcion responde WhatsApp pero la web es un escaparate muerto
- Las agencias tradicionales rechazan el sector
- Los chatbots genericos (ManyChat, Tidio) no entienden el catalogo ni las tarifas

Nuestro widget resuelve eso: **se instala en 1 linea**, entiende el catalogo, responde tarifas, traduce a 4 idiomas, y deriva al WhatsApp de recepcion cuando el cliente quiere reservar. Tres casas reales ya lo usan.

---

## Casos de exito (clientes en produccion)

| Casa | Web | Ciudad | En produccion desde |
|------|-----|--------|---------------------|
| Maxxag Valencia | maxxagvlc.com | Valencia | Activo |
| Maxxag Madrid | maxxagemadrid.com | Madrid | Activo |
| Mansion Babylon Marbella | mansionbabylonmarbella.com | Marbella | Activo |

Los tres llevan el widget en produccion, facturando, con conversaciones reales todos los dias.

---

## Que hace el widget

| Feature | Detalle |
|---------|---------|
| **Catalogo de servicios** | Lista de chicas disponibles hoy con foto y boton WhatsApp |
| **Tarifas en vivo** | Tabla de precios por servicio, salida hotel/domicilio incluida |
| **Horarios y direccion** | Como llegar, parking, horario de apertura |
| **Reservas** | Boton directo al WhatsApp de recepcion |
| **Multi-idioma** | ES, EN, FR, IT (los 4 perfiles tipicos de Costa del Sol y capitales) |
| **Servicios especiales** | Parejas, fetichismo, salidas, eventos |
| **IA con aprendizaje** | Claude Haiku responde preguntas libres y aprende de las conversaciones reales |
| **Panel admin** | Activar/desactivar chicas, editar tarifas, ver logs en tiempo real |

---

## Integracion en 1 linea

Para WordPress (95% del mercado adult-services en Espana):

```php
// functions.php del tema
add_action('wp_footer', function() {
    echo '<script src="https://widget.tu-dominio.com/v1/loader.js"
                  data-client="casa-XXX"
                  data-city="valencia"
                  data-lang="es"
                  defer></script>';
});
```

O usar el plugin oficial: subir, activar, configurar ciudad y WhatsApp. Listo en 5 minutos.

Para webs custom (HTML/JS):

```html
<script src="https://widget.tu-dominio.com/v1/loader.js"
        data-client="casa-XXX"
        data-city="madrid"
        data-lang="es"
        defer></script>
```

---

## Stack tecnico

- **Backend:** Flask + Claude Haiku (Anthropic)
- **Frontend:** Vanilla JS inyectable, sin dependencias, ~28KB gzip
- **Datos:** JSON versionado por cliente (catalogo, tarifas, textos)
- **Hosting:** VPS dedicado por cliente o multi-tenant compartido
- **Coste IA:** 2-5 EUR/mes con 500 chats/dia
- **Tiempo de respuesta:** < 1.2s en p95
- **Privacidad:** Logs anonimizados, sin PII almacenado, GDPR-friendly

---

## Que NO hacemos

Por transparencia con el cliente:

- No procesamos pagos en el widget (eso es problema de pasarela, ver proyecto 08)
- No publicamos anuncios (no somos un portal tipo Slumi)
- No gestionamos la web ni el SEO (somos el modulo de conversion, no la web entera)
- No hacemos onboarding de chicas (eso lo hace la casa)

Hacemos UNA cosa muy bien: convertir visitas en conversaciones de WhatsApp.

---

## Estructura de este proyecto

```
02-widget-adult-services/
├── README.md            ← este archivo
├── SALES.md             ← pricing, propuesta, objeciones
├── ROADMAP.md           ← 30 dias para tener producto vendible empaquetado
├── PRIMER_CLIENTE.md    ← perfil, guion llamada, email frio, referidos
├── DECISIONS.md         ← decisiones tecnicas y comerciales
├── pitch.md             ← deck 12 slides
└── landing/
    └── index.html       ← landing 1-pagina
```

---

## Contacto comercial

Email: ainhoanochesdeverano@gmail.com
WhatsApp: el de coordinacion (no publicar en landing publica hasta tener pricing cerrado)
