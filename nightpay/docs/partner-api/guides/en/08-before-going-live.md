## 8. Before going live

**What OxioPay must have done:**

- [ ] OxioPay confirms the live host and the go-live date.
- [ ] The partner agreement and the data processing agreement are signed.
- [ ] Your company is registered as a partner, with its outbound IPs.
- [ ] The pilot venue's company has its legal name and tax id in OxioPay (they appear on the ticket).
- [ ] One connection is set up: the pilot venue, `venue_collects`, `wallet:balance` and `wallet:load`, your fixed IPs, default limits, card off.
- [ ] OxioPay switches the live API on for that venue and confirms it to you in writing.

**What the ATM side must have done:**

- [ ] The live key only on your servers (secrets manager), never in the ATMs, in the code or in the logs. It arrives through the one-time link, opened only when storing it.
- [ ] Calls go out only from the registered IPs (IPv6 too, or IPv4 forced), over TLS with certificate checks, with no proxy that opens TLS or logs headers. No `Origin` header. The key only in `Authorization`.
- [ ] `GET /me` at start-up and every hour; terms, issuer and limits taken from there; an internal alert as soon as `key.replaced` is `true` and 30 days before `key.expires_at`; out of service with `livemode: false` in live.
- [ ] A transaction id unique forever per venue (8 to 64 characters, ending in random characters), used as `Idempotency-Key` and as `reference`, and `device` on every load.
- [ ] Each transaction written to durable storage before the call; restarts and escrow time-outs recovered (4.3).
- [ ] The escrow flow tested: `201` → cash box and ticket (replays checked); refusal → give back; no response → retry with the same `Idempotency-Key`; if still unknown → reconcile by `reference` before giving anything back; "pending" ticket if OxioPay does not answer.
- [ ] Expired phone code → read again, balance confirmed by the customer, and repeat with the same id.
- [ ] Maximum per top-up checked before calling.
- [ ] Cash only (`funding: "cash"`).
- [ ] The scanner in serial mode; only `OXC1:`, `NPF:`, `https://` and 6-character texts sent.
- [ ] Your reader's serial is the one an Android phone reads (tested on the demo with your own ficha); before opening to customers, three real fichas of the pilot venue tapped on a live ATM with the manager: none answers `ficha_copy_suspected`.
- [ ] Terms on screen, with acceptance, before taking the money; complete ticket (4.7).
- [ ] The chapter 5 texts in Spanish and English.
- [ ] Void only when the money did not stay with the venue, within the 10 minutes, before giving the notes back.
- [ ] Reconciliation per night and per venue with `/wallet/operations` and `/statement`, equal to your cash count.
- [ ] In the logs: `Request-Id`, `wl_…`, `reference`, amount and error code. Never the key, the QR text, the UID, the phone codes or balances.
- [ ] All the tests from chapter 7, done on the demo.
