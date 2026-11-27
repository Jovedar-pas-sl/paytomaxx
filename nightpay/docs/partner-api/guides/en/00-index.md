# ATM guide: loading balance with the OxioPay API (pilot)

**There is no refund and no cash withdrawal of the balance.** No call in this API takes money out of a wallet.

This guide is for whoever programs the ATM platform. The ATMs stand inside the venues and **only load balance**: they never pay with balance and never hand out cash from a wallet.

- **The contract is `openapi-piloto.yaml`** (in English). If this guide and the YAML disagree, the YAML wins. The examples here are the same as the YAML's: same ids, amounts and codes. The code blocks are identical to those of the Spanish guide, so their comments are in Spanish.
- **Addresses.** They are not chosen yet. Everything ending in `.example` is a placeholder:

| What | Live | Demo (testing) |
|---|---|---|
| API | `https://api.oxiopay.example/v1/partner` | `https://demo-api.oxiopay.example/v1/partner` |
| Link written on the fichas (NFC tags) | `https://<app host>/?ficha=<code>` | `https://demo-operator.oxiopay.example/?ficha=<code>` |
| Documentation (error types) | `https://docs.oxiopay.example` | |

- **Standing rules.** JSON in UTF-8. Amounts in **cents** and always in euros (`2000` = 20.00 €). Times in UTC (`Z`). The venue's "night" runs from 08:00 to 08:00 (Madrid time) and is named after the day it starts (`business_date`). No response carries the wallet's id, the customer's name or phone number, their 6-character code or their ficha's number. If a response brings a field or a code you do not know, ignore it (or handle it by its HTTP status, chapter 5): the API only grows, it never changes what is already there. On the other hand, an extra field in what you send is refused (`422 validation_failed`). Every response carries `Cache-Control: no-store`.
- **Not in the pilot**: paying with balance, charges, notifications (webhooks) and events, and reports. They will come later without breaking anything.

## Chapters

1. [Get started: three calls on the demo](01-get-started.md)
2. [Keys and security](02-keys-and-security.md)
3. [Identifying the customer](03-identifying-the-customer.md)
4. [Loading balance at an ATM](04-loading-balance.md)
5. [Errors and retries](05-errors-and-retries.md)
6. [Reconciliation](06-reconciliation.md)
7. [Testing on the demo](07-testing-on-the-demo.md)
8. [Before going live](08-before-going-live.md)
