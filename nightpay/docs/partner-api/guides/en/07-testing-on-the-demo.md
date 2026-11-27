## 7. Testing on the demo

**The demo** is a separate OxioPay installation in test mode: `oxp_test_…` keys, responses with `livemode: false`, made-up data and no real money. Live refuses test keys and the demo refuses live keys (`401 wrong_environment`). On the demo the IP list is optional; if OxioPay sets one, it works the same as in live. OxioPay will let you know when the demo is ready.

**Test fichas.** Always the same ones. Their link is `https://demo-operator.oxiopay.example/?ficha=<code>` (you can write it to your own NTAG fichas to test with the real reader). None of them has a phone number. Test keys are for the demo venue «Local Demo Centro» (or another venue of its company and group), the only ones that reach these fichas, and everyone testing on the demo shares them: run limit tests right after `POST /test/fixtures/reset`, and expect loads by other testers.

| Ficha (`fixture`) | Code | Stored UID | Balance | What it answers |
|---|---|---|---|---|
| `active` | `demo-ficha-active-0001` | none | 50.00 € | Works |
| `empty` | `demo-ficha-empty-00001` | none | 0.00 € | Balance 0; loading works |
| `ficha_uid` | `demo-ficha-uid-0000001` | `04A1B2C3D4E5F6` | 50.00 € | Works; with another UID → `409 ficha_copy_suspected` |
| `blocked` | `demo-ficha-blocked-001` | none | 50.00 € | `409 wallet_blocked` |
| `closed` | `demo-ficha-closed-0001` | none | 0.00 € | `409 wallet_closed` |
| `lost_ficha` | `demo-ficha-lost-000001` | none | 50.00 € | The ficha → `409 ficha_lost`; a phone code for its wallet works |
| `ficha_blocked` | `demo-ficha-fblocked-01` | none | 50.00 € | The ficha → `409 ficha_blocked`; a phone code for its wallet works |
| `other_group` | `demo-ficha-othergroup1` | none | 50.00 € | `404 wallet_not_found` (another group of venues) |
| `other_company` | `demo-ficha-othercomp01` | none | 50.00 € | `404 wallet_not_found` (same group, another company) |

Since `active` has no stored UID, any ficha of yours with that link written on it serves to test the real NFC reader. `ficha_uid` only tests the format, sending the UID by hand. To check your reader's byte order, ask OxioPay to register one of your own NTAG fichas on the demo, read by an Android phone at the demo reception: read it with your ATM; it must answer `200`, never `ficha_copy_suspected`.

**Sample refused texts.** The refusal depends only on the shape of the text, so these made-up texts give these answers:

| `qr` | Response |
|---|---|
| `https://demo-api.oxiopay.example/c/demoGoogleWalletPass00000000000000000000001` | `422 wallet_ref_not_accepted`, `reason: wallet_pass` |
| `https://demo-api.oxiopay.example/w/demoPrivateLink000000001` | `reason: private_link` |
| `NPF:K7Q4M2:demoReceptionProof0001` | `reason: reception_qr` |
| `K7Q4M2` | `reason: short_code` |
| `https://demo-api.oxiopay.example/pay/demoChargeLink000000000000000001` | `reason: charge_link` |
| `https://demo-api.oxiopay.example/w/a/demoActivationLink000001` | `reason: other_link` |
| `https://example.org/carta` | `422 wallet_ref_unrecognized` |

**Test helpers** (they only exist on the demo; in live they give `404`):

```bash
# Un código del móvil para una ficha de prueba: vale 60 segundos y solo identifica
curl -sS "$OXP_BASE/test/live-codes" \
  -H "Authorization: Bearer $OXP_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fixture":"active"}'
# 201 {"object":"test_live_code","code":"OXC1:K3J7Q2M9X4T8R6V1N5B0C2D7F9","expires_in":60,"livemode":false}

# Dejar todas las fichas de prueba como al principio (sin cuerpo ni Content-Type)
curl -sS -X POST "$OXP_BASE/test/fixtures/reset" -H "Authorization: Bearer $OXP_KEY"
# 204, sin cuerpo
```

- You can send the code directly in `qr`, or draw it as a QR (alphanumeric mode) on a phone or a screen to test the ATM's scanner.
- The reset gives each test ficha a fresh wallet with its starting balance and state, with the same links and UIDs. Loads already made stay in `/wallet/operations` and `/statement`, but no longer count toward the fichas' limits; your connection's night limit still counts them. Earlier phone codes stop working.
- On request, OxioPay puts your test connection or the demo venue in the states that answer `method_disabled`, `venue_paused`, `partner_api_frozen`, `connection_paused` and `scope_paused`, and back.

**What to test before asking to go live:**

1. The three calls from chapter 1.
2. Each test ficha, by NFC (link + UID) and with a phone code, and each text from chapter 3.
3. Each sample refused text above, and a text your ATM must not send (a Wi-Fi QR): it shows «No reconocemos este código» without calling.
4. An expired phone code (wait more than 60 seconds): `live_code_invalid` → show it again, balance confirmed by the customer → same transaction.
5. A load above the maximum per top-up (your ATM should never get as far as calling) and two loads of 300 € and one of 0.01 € on the same wallet (`limit_exceeded`, `limit: wallet_24h`). `cash_limit_reached` only triggers if the same wallet already holds cash from reception: to see it, ask OxioPay to load cash at reception onto a test ficha; otherwise, treat it like any `402` refusal.
6. `funding: "card"` → `422 funding_not_allowed`.
7. A retry with the same `Idempotency-Key` and the same body → `Idempotent-Replayed: true`, recognised as this transaction's; the same key with another body → `idempotency_key_reused`; an id already used by an earlier transaction → notes given back.
8. A simulated timeout (cut the network after sending): retry, and reconciliation by `reference`.
9. A restart of your servers and of an ATM in the middle of a transaction, and an escrow that gives the notes back by itself (4.3).
10. A void within the 10 minutes, made before giving the notes back and repeated (same response), and after the 10 minutes (`void_window_passed`). `balance_already_spent` needs the customer to spend at the venue: on the demo it cannot be triggered from the ATM.
11. Each venue state that OxioPay sets on request: the ATM shows the chapter 5 text, and with `scope_paused` you can still look up and void your loads.
12. A night's reconciliation with `/wallet/operations` and `/statement`, and that your totals match.
13. A request without `Idempotency-Key`, with the key in the URL, and with the key expired or revoked (ask OxioPay for it): the ATM goes "out of service".
14. Your own NTAG ficha, registered by OxioPay on the demo: it answers `200`, never `ficha_copy_suspected`.

The 1,500 € limit in 30 days is not reached quickly on the demo (the 24-hour ones come first): treat any `limit_exceeded` the same way.

Watch out: the automatic pause also works on the demo. Three refusals by the maximum per top-up within 10 minutes stop your test connection's loads until OxioPay resumes them: space those tests at least 10 minutes apart.
