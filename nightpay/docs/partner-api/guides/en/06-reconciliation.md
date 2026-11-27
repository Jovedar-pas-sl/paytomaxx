## 6. Reconciliation

**The venue's night.** It runs from 08:00 to 08:00 (Madrid time) and is named after the day it starts: the night `2026-12-05` runs from 5 December at 08:00 to 6 December at 08:00. In UTC: in winter from 07:00Z to 07:00Z, in summer from 06:00Z to 06:00Z. The night of the clock change lasts 23 or 25 hours. A load at 00:41 on Saturday belongs to Friday's night.

**The loads of a night**: `GET /wallet/operations?business_date=2026-12-05`. Only this connection's (this venue's), oldest first, up to 100 per page (`limit`), with `next_cursor` for the next page (send it as `cursor` with the same filters). Each load appears once, in the night it was made, with its current status (`succeeded` or `voided`, and `voided_at`, whether you or the venue voided it). Instead of `business_date` you can give `from` and `to` (up to 31 days, `to` excluded); both, neither, only one of them, or a `to` not after `from` → `422 validation_failed`. With `reference` you look up one specific transaction:

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

A load appears once OxioPay has finished saving it (at most 30 seconds after it arrived): to get the complete night, read it once the night is over (from 08:05). Reading your loads and the totals keeps working during an automatic pause.

**The totals**: `GET /statement?from=2026-12-05T07:00:00Z&to=2026-12-06T07:00:00Z` (up to 92 days, `to` excluded). They are the same figures the owner sees in «Movimientos» for this connection. Loads count at the moment they were made and voids at the moment of the void, also when the venue voids from its panel (so a load at 07:58 voided at 08:03 falls into two different nights). `net_loads` = loads − voids.

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

**The money.** It belongs to the venue, like the money in the reception till: OxioPay owes you nothing and you owe OxioPay nothing. The ATMs' cash is not part of the reception drawer: the night-close cash count does not expect it there, and the venue's night close (Z report) shows it on its own line, «Caja · Cajeros Demo», which is counted by whoever empties the ATMs. Each ATM's cash is counted every night against `net_loads`, and a shortfall goes to the owner the same day. For each venue and each night, your ATMs' cash must match `net_loads` of `GET /statement` for the same `from` and `to` (in the pilot every load is cash). It matches the «Caja · …» line of the venue's Z when the venue closed the night at 08:00; if it closed earlier, loads made between the close and 08:00 appear in the next Z, and a load voided after 08:00 is subtracted in the night of the void. The split between the ATM company and the venue is handled outside the API. Totals per ATM come from your own records (the API gives totals per venue).

To compute a night's `from` and `to` in Node, without libraries (there is never a clock change at 08:00):

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
