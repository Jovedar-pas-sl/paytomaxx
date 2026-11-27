---
en_sha256: c77fec936fe5f9056e2736c045278a536f5df8b0b9c14d1074f250bf169354ab
---
# Guía para los cajeros: cargar saldo con la API de OxioPay (piloto)

**No hay devolución ni retirada en efectivo del saldo.** Ninguna llamada de esta API saca dinero de un saldo.

Esta guía es para quien programa la plataforma de cajeros. Los cajeros están dentro de los locales y **solo cargan saldo**: nunca pagan con saldo ni dan efectivo de un saldo.

- **El contrato es `openapi-piloto.yaml`** (en inglés). Si esta guía y el YAML no dicen lo mismo, manda el YAML. Los ejemplos de aquí son los mismos que los del YAML: mismos ids, importes y códigos.
- **Direcciones.** Todavía no están elegidas. Todo lo que acaba en `.example` es provisional:

| Qué | Real | Demo (pruebas) |
|---|---|---|
| API | `https://api.oxiopay.example/v1/partner` | `https://demo-api.oxiopay.example/v1/partner` |
| Enlace grabado en las fichas | `https://<host de la app>/?ficha=<código>` | `https://demo-operator.oxiopay.example/?ficha=<código>` |
| Documentación (tipos de error) | `https://docs.oxiopay.example` | |

- **Reglas de siempre.** JSON en UTF-8. Importes en **céntimos** y siempre en euros (`2000` = 20,00 €). Horas en UTC (`Z`). La «noche» del local va de 08:00 a 08:00 (hora de Madrid) y se llama por el día en que empieza (`business_date`). Ninguna respuesta lleva el id del saldo, el nombre ni el teléfono del cliente, su código de 6 letras ni el número de su ficha. Si una respuesta trae un campo o un código que no conoces, ignóralo (o trátalo por su estado HTTP, capítulo 5): la API solo crece, nunca cambia lo que ya hay. En cambio, un campo de más en lo que tú envías se rechaza (`422 validation_failed`). Toda respuesta lleva `Cache-Control: no-store`.
- **Lo que no entra en el piloto**: pagar con saldo, cobros, avisos (webhooks) y eventos, e informes. Llegarán después sin romper nada.

## Capítulos

1. [Empieza: tres llamadas en la demo](01-empieza.md)
2. [Claves y seguridad](02-claves-y-seguridad.md)
3. [Identificar al cliente](03-identificar-al-cliente.md)
4. [Cargar saldo en un cajero](04-cargar-saldo.md)
5. [Errores y reintentos](05-errores-y-reintentos.md)
6. [Cuadre](06-cuadre.md)
7. [Pruebas en la demo](07-pruebas-en-la-demo.md)
8. [Antes de salir](08-antes-de-salir.md)
