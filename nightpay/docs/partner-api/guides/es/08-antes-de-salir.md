---
en_sha256: f851f8823356aef0a75a6e34daafb998346ff34c0224f3152a80548db29afb88
---
## 8. Antes de salir

**Lo que tiene que haber hecho OxioPay:**

- [ ] OxioPay confirma la dirección real y la fecha de salida.
- [ ] Firmados el contrato de socio y el contrato de encargo de tratamiento de datos.
- [ ] Vuestra empresa, dada de alta como socio, con sus IP de salida.
- [ ] La sociedad del local piloto, con su razón social y su NIF en OxioPay (salen en el tique).
- [ ] Una conexión preparada: el local piloto, `venue_collects`, `wallet:balance` y `wallet:load`, vuestras IP fijas, topes de serie, tarjeta apagada.
- [ ] OxioPay enciende la API real para ese local y os lo confirma por escrito.

**Lo que tiene que estar hecho por parte de los cajeros:**

- [ ] La clave real solo en vuestros servidores (gestor de secretos), nunca en los cajeros, en el código ni en los logs. Llega por el enlace de un solo uso, abierto solo al guardarla.
- [ ] Las llamadas salen solo de las IP registradas (también IPv6, o IPv4 forzado), por TLS con comprobación del certificado, sin un proxy que abra el TLS o registre cabeceras. Sin cabecera `Origin`. La clave solo en `Authorization`.
- [ ] `GET /me` al arrancar y cada hora; condiciones, emisor y topes tomados de ahí; aviso interno en cuanto `key.replaced` sea `true` y 30 días antes de `key.expires_at`; fuera de servicio con `livemode: false` en real.
- [ ] Id de transacción único para siempre por local (de 8 a 64 caracteres, acabado en caracteres al azar), usado como `Idempotency-Key` y como `reference`, y `device` en cada carga.
- [ ] Cada transacción apuntada en un almacenamiento que no se borre antes de llamar; reinicios y depósitos que devuelven solos, resueltos (4.3).
- [ ] Flujo con depósito probado: `201` → caja y tique (repeticiones comprobadas); rechazo → devolver; sin respuesta → reintentar con la misma `Idempotency-Key`; si sigue sin saberse → conciliar por `reference` antes de devolver nada; tique «pendiente» si OxioPay no contesta.
- [ ] Código del móvil caducado → leer otra vez, saldo confirmado por el cliente, y repetir con el mismo id.
- [ ] Máximo por recarga comprobado antes de llamar.
- [ ] Solo efectivo (`funding: "cash"`).
- [ ] El lector de QR en modo serie; solo se mandan textos `OXC1:`, `NPF:`, `https://` y de 6 caracteres.
- [ ] El número de serie que da vuestro lector es el mismo que lee un Android (probado en la demo con una ficha vuestra); antes de abrir a los clientes, tres fichas reales del local piloto acercadas a un cajero en real, con el encargado: ninguna da `ficha_copy_suspected`.
- [ ] Condiciones en pantalla, con aceptación, antes de coger el dinero; tique completo (4.7).
- [ ] Textos del capítulo 5 en español e inglés.
- [ ] Anulación solo cuando el dinero no se quedó en el local, dentro de los 10 minutos, antes de devolver los billetes.
- [ ] Cuadre por noche y por local con `/wallet/operations` y `/statement`, igual a vuestro recuento de efectivo.
- [ ] En los logs: `Request-Id`, `wl_…`, `reference`, importe y código de error. Nunca la clave, el texto del QR, el UID, los códigos del móvil ni los saldos.
- [ ] Todas las pruebas del capítulo 7, hechas en la demo.
