## 2. Keys and security

**Where the key lives.** On the ATM platform's servers, in their secrets manager or in an environment variable. **Never inside each ATM**: the ATMs talk to your servers, and it is your servers that call OxioPay. A key serves **one venue** (one connection = the ATM platform × one venue): if your ATMs are in two venues, there are two keys, and each ATM uses its own venue's key.

**What it can do.** The ATM key holds only `wallet:balance` (read the balance) and `wallet:load` (load, void its own load, list its loads and their summary). It cannot pay with balance, charge, or read sales. It only reaches the wallets of its venue's group (the same check the venue's own staff make) whose home venue, where the wallet was created, belongs to the same company (same tax id, CIF) as its venue; a home venue without a company counts as another company. Any other wallet answers `404 wallet_not_found`, exactly like one that does not exist.

**How it is sent.** Only in the header `Authorization: Bearer oxp_live_…` (live) or `Bearer oxp_test_…` (demo).
- Never in the URL (`400 api_key_in_url`, and the owner gets an alert to rotate it) nor in the body (`400 api_key_in_body`).
- No `Origin` header: the API is server to server, and a request with `Origin` gets `403 browser_not_allowed`.
- A body of 16 KB at most (`413 body_too_large`). A POST without a body (a void without a reason) goes without `Content-Type`.
- Live does not accept test keys, nor does the demo accept live keys (`401 wrong_environment`).

**Transport.** Only `https://`, TLS 1.2 or later, with certificate verification on. Never `http://` (a key sent over http must be rotated) and never through a proxy that opens TLS or logs the `Authorization` header or request bodies; fixed outbound IPs often come from such a proxy, so check it. The link between each ATM and your servers carries the same secrets (ficha link, chip UID, phone code): encrypt it too, and switch off any logging of scanned text or UIDs in the ATM, its NFC and QR reader SDKs and its crash reports.

**Fixed IPs, mandatory in live.** In live, a key with `wallet:load` only works from the IPs of your servers that the owner registered (optional on the demo): up to 10, each one a single address (IPv4, or one IPv6 /64 block if your provider gives that whole /64 to you alone; otherwise the single address), within the ones OxioPay has on record for your company. The address compared is the public address your request reaches OxioPay's edge from: after your own NAT, outbound proxy or cloud gateway, not your server's private address. From another IP: `403 ip_not_allowed`, the owner gets an alert for each new address, and calls from 3 unregistered addresses within 24 hours stop new loads at every ATM of the venue (4.6). So never try the live key from a laptop, CI or a staging server. If one of your servers gets `ip_not_allowed`, ask the owner: their panel shows the address that was refused. Also give your IPv6 addresses if your servers go out over IPv6, or force IPv4 in the client: otherwise the call may leave from an address that is not on the list.

**Rotation.** Done by the owner, with their 2FA. The new key is shown only once: OxioPay emails a **one-time link** (valid 24 hours) to your company's registered contact email, or the owner hands it to you directly. Open the link only when you are about to store the key, on the machine that stores it; never screenshot it or paste it into a chat or an email. If the link says it is no longer valid and nobody on your team opened it, tell the owner at once: someone else saw the key and it must be rotated with no overlap. The old key keeps working during the overlap the owner chooses (none if there was a leak, 24 hours by default, or 7 days); meanwhile `GET /me` with the old key shows `key.replaced: true` and `key.expires_at` at the end of the overlap: alert your operators as soon as you see it. After the overlap it answers `401 api_key_rotated` for 30 days, so you can see why it fails. A rotation keeps the connection: the same `pc_` id, your loads and your transaction ids.

**Revocation.** By the owner or the manager, with one tap. It applies from the next request: `401 api_key_revoked`. If you ever suspect the key has leaked, tell the owner so they rotate it with no overlap.

**Expiry and dormancy.** A key with `wallet:load` expires after 365 days at most (`key.expires_at` in `GET /me`; after that, `401 api_key_expired`): alert your operators 30 days before and ask the owner for a rotation with a 7-day overlap. A key that makes no wallet call (balance, loads, voids, `/wallet/operations`, `/statement`) for 90 days is suspended (`401 api_key_suspended`) and the owner reactivates it; `GET /me` alone does not keep it alive.

**What is never logged or stored:**
- **The key**: not in logs, in the code, in the repository, in the ATMs or in URLs.
- **The raw QR text** (the phone code or the ficha link).
- **The chip number (UID)** beyond the transaction.
- **The live codes** (`OXC1:…`).
- **Customers' balances** (`available`, `balance_after`): only on the screen and the ticket.
- And nothing personal in `description` or in `reference`: no phone numbers, no emails, no long numbers.

What is logged, on every call: the response's `Request-Id` header, the load id (`wl_…`), your `reference`, the amount and the error code. From an error, log `code`, `status`, `request_id`, `param` and `limit`, never the whole body. If you send `X-Request-Id` (letters, digits and `-`, up to 64), OxioPay echoes it back as `Request-Id`.
