---
en_sha256: 2f4f03d23b3c996edada0b997bea6b8b42130f3234bddc3f65c1c5f9bd5608b0
---
## 6. Cuadre

**La noche del local.** Va de las 08:00 a las 08:00 (hora de Madrid) y se llama por el día en que empieza: la noche `2026-12-05` va del 5 de diciembre a las 08:00 al 6 de diciembre a las 08:00. En UTC: en invierno de 07:00Z a 07:00Z, en verano de 06:00Z a 06:00Z. La noche del cambio de hora dura 23 o 25 horas. Una carga a las 00:41 del sábado es de la noche del viernes.

**Las cargas de una noche**: `GET /wallet/operations?business_date=2026-12-05`. Solo las de esta conexión (este local), las más antiguas primero, hasta 100 por página (`limit`), con `next_cursor` para la siguiente (mándalo como `cursor` con los mismos filtros). Cada carga sale una vez, en la noche en que se hizo, con su estado de ahora (`succeeded` o `voided`, y `voided_at`, tanto si la anulasteis vosotros como el local). En lugar de `business_date` puedes dar `from` y `to` (hasta 31 días, `to` excluido); los dos, ninguno, solo uno de ellos, o un `to` que no es posterior a `from` → `422 validation_failed`. Con `reference` buscas una transacción concreta:

`GET /wallet/operations?business_date=2026-12-05&reference=ATM0042-20261205-000731-K7QM` (`200`):

```json
{
  "object": "list",
  "data": [
    {
      "object": "wallet_load",
      "id": "wl_8b2e6f1a9c3d4e5f8a7b6c5d4e3f2a1b",
      "status": "succeeded",
      "amount": 2000,
      "currency": "EUR",
      "description": "Recarga en cajero 0042",
      "reference": "ATM0042-20261205-000731-K7QM",
      "funding": "cash",
      "device": "ATM0042",
      "created_at": "2026-12-05T22:41:07Z",
      "void_until": "2026-12-05T22:51:07Z",
      "balance_after": 7000,
      "terms": {
        "url": "https://demo-api.oxiopay.example/legal/condiciones#saldo",
        "version": "2026-11-17",
        "summary_es": "El saldo se gasta en este local y en los de su grupo que lo aceptan. No se devuelve en dinero, ni en efectivo ni a la tarjeta.",
        "summary_en": "The balance is spent at this venue and at the venues of its group that accept it. It is not refunded in money, neither in cash nor to a card."
      },
      "voided_at": null,
      "livemode": false
    }
  ],
  "has_more": false,
  "next_cursor": null
}
```

Una carga aparece cuando OxioPay termina de guardarla (como mucho 30 segundos después de recibirla): para tener la noche completa, léela cuando ya haya terminado (a partir de las 08:05). Leer tus cargas y los totales sigue funcionando durante una pausa automática.

**Los totales**: `GET /statement?from=2026-12-05T07:00:00Z&to=2026-12-06T07:00:00Z` (hasta 92 días, `to` excluido). Son los mismos números que ve el dueño en «Movimientos» para esta conexión. Las cargas cuentan en el momento en que se hicieron y las anulaciones en el momento de la anulación, también cuando el local anula desde su panel (por eso, una carga a las 07:58 anulada a las 08:03 cae en dos noches distintas). `net_loads` = cargas − anulaciones.

```json
{
  "object": "statement",
  "from": "2026-12-05T07:00:00Z",
  "to": "2026-12-06T07:00:00Z",
  "currency": "EUR",
  "livemode": false,
  "loads": {
    "count": 3,
    "amount": 9000,
    "by_funding": {
      "cash": { "count": 3, "amount": 9000 },
      "card": { "count": 0, "amount": 0 },
      "transfer": { "count": 0, "amount": 0 },
      "bank_app": { "count": 0, "amount": 0 }
    }
  },
  "load_voids": { "count": 1, "amount": 5000 },
  "net_loads": 4000
}
```

**El dinero.** Es del local, como el de la caja de recepción: OxioPay no os debe nada ni vosotros a OxioPay. El efectivo de los cajeros no forma parte del cajón de recepción: el arqueo del cierre no lo espera en el cajón, y el cierre de la noche (Z) del local lo enseña en una línea propia, «Caja · Cajeros Demo», que cuenta quien vacía los cajeros. El efectivo de cada cajero se cuenta cada noche contra `net_loads`, y si falta dinero se avisa al dueño ese mismo día. Para cada local y cada noche, el efectivo de vuestros cajeros debe cuadrar con `net_loads` de `GET /statement` para el mismo `from` y `to` (en el piloto todas las cargas son en efectivo). Con la línea «Caja · …» del Z del local cuadra si el local cerró la noche a las 08:00; si la cerró antes, lo cargado entre el cierre y las 08:00 sale en el Z siguiente, y una carga anulada después de las 08:00 resta en la noche de la anulación. El reparto entre la empresa de los cajeros y el local va fuera de la API. Los totales por cajero los sacáis de vuestros registros (la API da totales por local).

Para calcular `from` y `to` de una noche en Node, sin librerías (a las 08:00 nunca hay cambio de hora):

```js
// 08:00 de Madrid del día `fecha` (AAAA-MM-DD), como Date en UTC.
function madrid0800(fecha) {
  const invierno = new Date(`${fecha}T07:00:00Z`);
  const hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(invierno);
  return hora === '08' ? invierno : new Date(`${fecha}T06:00:00Z`);
}
const diaSiguiente = (fecha) => new Date(Date.parse(`${fecha}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const noche = '2026-12-05';
const q = new URLSearchParams({ from: madrid0800(noche).toISOString(), to: madrid0800(diaSiguiente(noche)).toISOString() });
// GET /statement?from=2026-12-05T07:00:00.000Z&to=2026-12-06T07:00:00.000Z
```
