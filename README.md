# Sluice

Open-source router for Stellar liquidity across Classic (SDEX, Classic pools) and Soroban (AMMs, vaults). It tells you which routes are atomic and which are not, and lets you execute them from your own wallet. See [PRD.md](./PRD.md) for scope, evidence and open questions.

Mainnet only. Non-custodial: the server builds and simulates transactions and relays the ones your wallet has signed. It never holds a key.

## Layout
| Path | What |
|---|---|
| `packages/core` | Quote sources (Horizon paths, Aquarius, Soroswap, Phoenix, Comet), router, atomicity classifier, stablecoin scoring, execution builders (Classic path payment, Aquarius, Soroswap, Phoenix, Comet, Sluice router contract, Blend supply and withdraw, trustline), `planExecution`, simulation via `prepare()`, submit and status over Stellar RPC, settled-amount decoding, plain-language error explanations, public asset lists, Blend pool reads |
| `packages/api` | Hono REST API (below). Serves the built web app when it exists |
| `packages/sdk` | Typed client for every endpoint, plus `waitForTx` and `unwind` |
| `packages/solver` | The settlement solver (testnet prototype): fill policy (`evaluateFill`), the hedge executor with failed-hedge recovery (bounded retries inside a loss bound, a circuit breaker, never a dump), durable state (atomic JSON file store), the recovery loop, and the standalone **solver service** (`pnpm solver`) that owns the solver key and that the API calls through a client |
| `apps/web` | Vite + React app: wallet connect, live routes, review, sign, submit, status; two-transaction routes with resume and unwind; Blend deposit, zap and withdraw; stablecoin health |
| `api/index.js`, `vercel.json` | The same API as one Vercel function, with the web app on the CDN |
| `contracts/router` | Soroban router: atomic multi-leg swaps over Soroswap routers and Phoenix/Comet pools, non-custodial, min-out on measured balance delta. Not used on mainnet (unaudited) |
| `contracts/settle` | Prototype. A user-signed order any solver can fill in one Soroban transaction, so a route that needs Classic liquidity is atomic for the user while the solver carries the Classic hedge. Testnet only, unaudited. Exposed through `/v1/orders/*` (off by default, mainnet refused): see [Settlement orders](#settlement-orders-testnet-prototype) |
| `scripts` | Read-only mainnet probes (`w0:*`) and testnet-only settlement scripts (`w1`..`w6`: contract, solver, hedge failure, API and SDK, recovery across a restart, the transaction-signing tier) |

## Run
```bash
pnpm install
pnpm build                         # packages, then the web app into apps/web/dist
pnpm start                         # API and web app on http://localhost:8787
pnpm test                          # 696 TypeScript tests (core 82, api 244, sdk 53, solver 203, web 114)
PW_CHANNEL=chrome pnpm e2e         # 12 browser checks on desktop and phone, against live mainnet data
pnpm w0:testnet-flow               # settles real testnet swaps with throwaway keys (post-signature path)
pnpm w1:settle-testnet             # fills a user-signed order through contracts/settle on testnet (build the contract first)
pnpm w4:orders-api-testnet          # the same through the API and SDK: prepare, sign with a throwaway wallet key, submit, hedge (testnet; build the contract first)
pnpm w5:recovery-restart-testnet    # fill, force a failed hedge, kill the solver service, restart it on its state directory: recovery resumes and clears the exposure (testnet; `pnpm build` and the contract first)
pnpm w6:tx-tier-testnet             # the transaction-signing tier end to end, with negatives (testnet; `pnpm build` and the contract first)
pnpm solver                         # the standalone solver service (needs SOLVER_* from .env.example; `pnpm build` first)
cd contracts && cargo test         # 13 router and 9 settle contract tests
cd contracts && stellar contract build --manifest-path router/Cargo.toml   # soroban-sdk 28 refuses plain cargo build
```
For development run `pnpm dev` (API on :8787) and `pnpm dev:web` (Vite on :5173, proxying `/v1`).
`PW_CHANNEL=chrome` uses an installed Chrome; without it run `pnpm --filter @sluice/web exec playwright install chromium` once.
Set `SLUICE_IPV4_FIRST=1` if fetch fails with ETIMEDOUT (broken IPv6 route). Configuration is in [.env.example](./.env.example).

## API
All amounts are decimal strings with at most 7 places. Assets are `native` or `CODE:ISSUER`. Errors are `{ error }`, and where the cause is known also `{ explained: { code, message, detail } }` with a sentence fit to show a user. CORS is open on `/v1/*`.

| Endpoint | Purpose |
|---|---|
| `GET /v1/quote?assetIn&assetOut&amount[&slippageBps][&atomicOnly=1]` | Routes, best first. Each has a `key` that names it across re-quotes, an atomicity class, legs with per-leg `minOut`, and risk notes. `partial` is true when a venue did not answer |
| `POST /v1/build` `{ assetIn, assetOut, amount, account, slippageBps?, routeKey? }` | Unsigned transactions for a route, simulated on mainnet, valid for 5 minutes. Adds a `changeTrust` prerequisite when the account lacks a trustline. With `routeKey` it builds exactly that route (409 `ROUTE_GONE` if it no longer exists); without it, the best route with fallback to the next when a simulation fails |
| `POST /v1/submit` `{ xdr }` | Relays a transaction the user's wallet already signed. Refuses unsigned, multi-operation and fee-bump envelopes |
| `GET /v1/tx/:hash` | `NOT_FOUND`, `SUCCESS` or `FAILED`. On success, `received` is what a swap actually delivered (read from the transaction result, not from a balance). On failure, `explained` says why |
| `GET /v1/account/:id` | Balances and spendable amounts (after reserve and open-offer liabilities). 404 for an unfunded account |
| `GET /v1/assets` | Pickable assets merged from three public SEP-42 lists (StellarExpert top 50, Soroswap, LOBSTR curated), cached an hour |
| `GET /v1/asset?id=CODE:ISSUER` | Confirms an asset exists on mainnet; issuer flags and holder count |
| `GET /v1/stablecoin?asset=` · `GET /v1/stablecoins` | Live peg (from executable quotes), depth, issuer flags and an explainable score, for one asset or for the scored set |
| `GET /v1/vaults` · `GET /v1/positions?account=` | Blend pools with status, reserves, utilisation and current rates read from the pool contract; an account's supplied positions |
| `POST /v1/deposit` · `POST /v1/withdraw` `{ account, vault, protocol: "blend", asset, amount }` | Unsigned, simulated Blend supply or withdrawal |
| `GET /v1/orders/config` | **Testnet prototype, off by default.** Whether settlement orders are on, on which network, with which contract and solver. See [Settlement orders](#settlement-orders-testnet-prototype) |
| `POST /v1/orders/prepare` `{ account, assetIn, assetOut, amount, slippageBps?, validForSec? }` | Prices an order against the Classic order book and returns the authorisation entry the wallet signs, or says why no solver will fill it |
| `POST /v1/orders/submit` `{ orderId, order, signedAuthEntry }` | Verifies the order id and the signed entry, re-simulates, and has the solver submit the fill. The user sends no transaction |
| `POST /v1/orders/prepare-tx` `{ account, assetIn, assetOut, amount, slippageBps?, validForSec? }` | Tier 2, for wallets that can sign a transaction but not an authorisation entry. Prices like `prepare` and returns an unsigned transaction **sourced from the user** (the user pays its fee) with the solver's authorisation already signed |
| `POST /v1/orders/submit-tx` `{ orderId, order, signedTx }` | Verifies the signed transaction (source, the one operation, every argument, both authorisations, time bounds, sequence), simulates it exactly as signed, and has it sent |
| `GET /v1/orders/:hash` | `NOT_FOUND`, `SUCCESS` or `FAILED` for a fill of either tier; on success the amount the user actually received, on failure a plain-language reason; and the solver's `hedge` status (`PENDING`, `HEDGING`, `HEDGED`, `RETRYING`, `UNHEDGED`, `ABANDONED`, `NOT_NEEDED`), which never changes the fill's own status |

Cross-layer routes are two transactions. `/v1/build` pre-builds leg 1 only; after it settles, quote the second pair for the `received` amount and build that. The web app and `sdk.unwind()` do this for you.

## Settlement orders (testnet prototype)
A route that needs Classic liquidity cannot share a Soroban transaction with a Soroban leg, so today it is two transactions and the user carries the risk in between. `contracts/settle` is a prototype of the alternative: the user signs **one Soroban authorisation entry** (what a wallet's `signAuthEntry` produces, not a transaction), and a **solver** submits the fill, pays the fee, pays the user from its own inventory and then hedges on the Classic DEX in a separate transaction. For the user it is one atomic step: at least `min_out` arrives, or nothing moves, and the user sends no transaction and pays no fee. This section is the API for it.

**Status.** Disabled unless configured (`ORDERS_*` in [.env.example](./.env.example)). **Testnet only**: the orders feature reads its own network settings, separate from the mainnet API above, and it refuses the public-network passphrase with no override (`ORDERS_MAINNET_REFUSED`), both when the environment is read and against the network the RPC endpoint itself reports (checked on first use). The settle contract is **unaudited**. The web app does not use it yet.

**The solver is not non-custodial, and the user is.** What the user signs is bound to the exact order (contract, input transfer, `min_out`, deadline), so a solver cannot take more than `amount_in`, redirect it, or pay less than `min_out`; the contract measures the user's balance, it does not trust a return value. But the **solver holds a secret key and an inventory**: it pays the fill's fee (tier 1), pays the user from its own balance, quotes its own hedge, and can lose money (a hedge that fails leaves it holding the user's input). That is a custody posture the rest of Sluice deliberately does not have, so it is kept out of the API:

- **Remote (the production path).** The solver is its own service, `packages/solver` (`pnpm build && pnpm solver`, configured by `SOLVER_*`), with its own key, its own state directory and its own limits. The API is configured with only the solver's URL, a shared bearer token and its **public** address (`ORDERS_SOLVER_MODE=remote`); it cannot sign anything as the solver. A secret in the API's environment next to a remote solver is refused at startup, and the API refuses a service that reports a different address, contract or network. Put the service on a private network and the key behind a signer or HSM; the bearer token is not a substitute for network isolation.
- **Local (development and tests).** `ORDERS_SOLVER_MODE=local` runs the same solver code inside the API process, with `ORDERS_SOLVER_SECRET` there. It is explicit, it is never inferred next to a URL, and it is the old behaviour. Do not put a key that holds real value in it.

### Flow
1. `GET /v1/orders/config`: is it on, which network, which contract and solver.
2. `POST /v1/orders/prepare`: the server quotes the Classic hedge (Horizon strict-send, on the orders network), asks the solver policy (`evaluateFill`) whether it would fill at that size, sets `min_out` to the best the solver could pay less your slippage, records your authorisation entry by simulating `fill`, and returns the entry, the preimage to sign and an `orderId`. If no solver would fill, it says why and prepares nothing.
3. The wallet signs the preimage. The client wraps the signature into the entry (`signOrder`).
4. `POST /v1/orders/submit`: the server checks the `orderId`, that the entry authorises exactly this order and is signed by the order's account, asks the solver whether it is taking orders (the circuit breaker), re-simulates in enforcing mode, re-checks that the solver still wants the fill at the current price, and hands the signed entry to the solver, which checks all of it again with its own quote and sends the fill.
5. `GET /v1/orders/:hash` until `SUCCESS` or `FAILED`. The solver then hedges on its own; `hedge` on that response says how it is going.

The `prepare` and `submit` steps ask the solver `canFill` first. While it holds a position it could not hedge (see [Recovery and state](#recovery-and-state)), `prepare` answers `solverWillFill: false` with the skip reason `circuit_breaker` and nothing is signed.

`orderId` is stateless: `<amount_out in stroops>.<hex HMAC-SHA256>` over the order, the amount the solver agreed to pay, the entry's nonce and expiry ledger, the contract, the solver and the network, keyed by `ORDERS_MAC_SECRET`. No database; a serverless function can serve prepare and submit on different instances. Change the amount, `min_out`, an asset, the deadline or the expiry and it stops verifying.

### Endpoints
Amounts are decimal strings with at most 7 places, assets are `native` or `CODE:ISSUER`, errors are `{ error }` or `{ error, explained: { code, message, detail } }` like the rest of the API. `network` is `"testnet"`, `"futurenet"` or `"custom"`.

`GET /v1/orders/config` always answers 200:
```json
{ "enabled": true, "network": "testnet", "networkPassphrase": "Test SDF Network ; September 2015",
  "settleContract": "CB7J…WC6J", "solver": "GCS6…UQUBC",
  "signing": { "credentials": "address-legacy", "tiers": ["auth-entry", "tx"] },
  "limits": { "maxOrderIn": "1000.0000000", "validForSec": { "min": 120, "max": 3600, "default": 600 } } }
```
Disabled or refused: `{ "enabled": false, "code": "ORDERS_NOT_CONFIGURED" | "ORDERS_INCOMPLETE" | "ORDERS_INVALID" | "ORDERS_MAINNET_REFUSED", "reason": "…" }`, and the three routes below answer **501** `{ "error": "…", "explained": { "code": "ORDERS_DISABLED" | "ORDERS_MAINNET_REFUSED" | … } }`. `signing.credentials` is the kind of authorisation entry the auth-entry tier issues. Only `address-legacy` (`SOROBAN_CREDENTIALS_ADDRESS`) is issued today; `address-v2` is reserved. `signing.tiers` (added later; an older server omits it and offers only `auth-entry`) lists how a wallet can authorise an order: `auth-entry` needs the wallet's `signAuthEntry`, `tx` needs only `signTransaction`.

`POST /v1/orders/prepare` `{ "account": "G…", "assetIn": "SLFA:G…", "assetOut": "SLFC:G…", "amount": "100", "slippageBps": 50, "validForSec": 600 }` (`slippageBps` 0..5000, default 50; `validForSec` 120..3600, default 600). 200, one of two shapes, told apart by `solverWillFill`:
```json
{ "solverWillFill": true,
  "orderId": "954654993.53bea779c20df7…",
  "order": { "user": "G…", "assetIn": "SLFA:G…", "tokenIn": "C…", "amountIn": "100.0000000",
             "assetOut": "SLFC:G…", "tokenOut": "C…", "minOut": "95.2262374",
             "deadline": 1762380000, "createTrustline": true },
  "summary": { "pay": "100.0000000", "receiveAtLeast": "95.2262374", "expected": "95.4654993" },
  "authEntry": { "xdr": "AAAAAQ…", "preimage": "AAAAC…", "validUntilLedger": 5577282,
                 "credentials": "address-legacy", "networkPassphrase": "Test SDF Network ; September 2015" } }
```
`receiveAtLeast` is the signed floor (the contract refuses below it); `expected` is what the solver will pay if filled now, never below the floor. `createTrustline` is true when the account has no trustline for `assetOut`; the fill then creates it (CAP-0073) and the user needs no earlier transaction. `deadline` is ledger close time in unix seconds; `validUntilLedger` is when the signature stops being usable. Show `summary` to the user and keep `order` and `orderId` for submit.
```json
{ "solverWillFill": false,
  "skipReasons": ["no_hedge_quote"],
  "explained": { "code": "SOLVER_WILL_NOT_FILL", "message": "No solver will fill this order now. The Classic order book has no path deep enough to hedge this size, so the solver cannot fill it. Nothing was signed.", "detail": "no_hedge_quote" },
  "summary": { "pay": "500.0000000", "classicQuote": "…", "solverMaxPay": "…" } }
```
`skipReasons` come from the solver policy: `circuit_breaker` (the solver is holding a position it could not hedge and has paused), `deadline_too_close`, `order_too_large`, `inventory_too_low`, `no_hedge_quote`, `hedge_too_thin`, `hedge_below_amount_out`, `below_min_profit` (and a few internal ones). `classicQuote` and `solverMaxPay` are present when known. There is no `orderId` and nothing to sign. Errors: 400 bad input, 404 unfunded account, 422 `NO_TRUSTLINE` (the account holds none of `assetIn`) or a simulation failure with `explained`, 502 upstream, 501/503 disabled, refused or misconfigured, 503 `SOLVER_UNAVAILABLE` (the solver service cannot be reached, timed out, refused our token or answered nonsense; `explained.detail` is one of `unreachable`, `timeout`, `unauthorized`, `failed`, `bad_response`, `mismatch`, and nothing about the service's address is returned).

`POST /v1/orders/submit` `{ "orderId": "…", "order": <the order from prepare, unchanged>, "signedAuthEntry": "<base64 SorobanAuthorizationEntry>" }` returns `{ "hash": "…", "status": "PENDING" | "DUPLICATE" }`. Refusals, all with `explained.code`:

| Status | `explained.code` | Meaning |
|---|---|---|
| 400 | `BAD_ORDER_ID` | The id does not match the order and entry: not prepared by this server, or something in it was changed |
| 400 | `WRONG_SIGNER`, `BAD_SIGNATURE` | The entry is signed by another key, is unsigned, or the signature does not verify for this order on this network |
| 400 | `ENTRY_MISMATCH`, `UNSUPPORTED_CREDENTIALS` | The entry does not authorise exactly this order (contract, order, input transfer), or uses another credentials kind |
| 410 | `EXPIRED` | The signature window or the order deadline has passed (or too little time is left to fill and hedge). Prepare again |
| 409 | `SOLVER_WILL_NOT_FILL` | The price moved since prepare and the solver would now lose money, or the solver has paused (`skipReasons: ["circuit_breaker"]`); `skipReasons` says why. Prepare again |
| 503 | `SOLVER_UNAVAILABLE` | The solver service is down or unreachable. Nothing was sent. If the answer to a *fill* was lost in transit it may still have been sent: submit the same signed entry again, the solver answers a repeated signature with the first fill's hash |
| 422 | `BELOW_MIN_OUT`, `ALREADY_USED`, `INSUFFICIENT_BALANCE`, `SIMULATION_FAILED`, … | The enforcing simulation failed; `explained` says why. `ALREADY_USED`: this signed entry was already filled (replay) |
| 422 / 503 | as `/v1/submit` | The network rejected the transaction / is busy |

`GET /v1/orders/:hash`:
```json
{ "hash": "…", "status": "SUCCESS", "ledger": 5577176, "createdAt": 1762379000, "received": "95.4654993",
  "hedge": { "status": "HEDGED", "hash": "…", "received": "100.1…" } }
```
`status` is `NOT_FOUND` (not in a ledger yet), `SUCCESS` or `FAILED`. `received` is what the fill returned, which is the amount the user's balance grew by (read from the transaction's return value). On `FAILED`, `explained` maps the settle contract's errors in words (`BAD_AMOUNT` 1, `SAME_TOKEN` 2, `EXPIRED` 3, `BAD_SOLVER` 4, `BELOW_MIN_OUT` 5) or the transaction result codes. 404 if the hash is a transaction that is not a fill of the configured contract (the source account does not matter: a tier-2 fill is sourced from the user).

`hedge` is the solver's account of its own follow-up trade. **It never changes the fill's status**: the fill is read from the chain, the hedge from the solver, and a hedge that fails, retries or is abandoned leaves the user's `SUCCESS` as it was.

| `hedge.status` | Meaning |
|---|---|
| `PENDING` | The fill has not landed yet |
| `HEDGING` | The fill landed; the first hedge attempt is running |
| `HEDGED` | The position was sold on the Classic DEX (`hash`, `received`) |
| `RETRYING` | A hedge did not land. The position is open, bounded automatic retries are scheduled (`attempts`, `reason`, `nextRetryAt` in unix seconds) |
| `UNHEDGED` | A hedge did not land and nothing is retrying it (no recovery loop is running); the solver holds the input |
| `ABANDONED` | Automatic retries are spent. The position stays open and the circuit breaker stays tripped until an operator acts |
| `NOT_NEEDED` | The fill failed or never landed, so the solver took nothing |
| `UNKNOWN` | This server could not ask the solver (it is down); the fill status above is unaffected |

The status is the solver's durable record: it survives a restart of the solver and is the same on every API instance. `hedge` is absent for a transaction the solver has no record of.

### Signing in a wallet
The user signs the **HashIdPreimage** in `authEntry.preimage` (base64). Wallets that implement SEP-43 `signAuthEntry` (Stellar Wallets Kit, Freighter, …) take that base64 string, sign `sha256(preimage bytes)` and return `{ signedAuthEntry, signerAddress }`, where `signedAuthEntry` is the **64-byte raw ed25519 signature, base64** (not an entry). Turning that into the entry to submit:

1. Parse `authEntry.xdr` as a `SorobanAuthorizationEntry`; set its `signatureExpirationLedger` to `validUntilLedger` (already set).
2. Wrap the signature as `ScVal::Vec([ Map{ public_key: Bytes(32 raw key of the user), signature: Bytes(64) } ])`, keys as symbols. This is what `authorizeEntry(entry, async () => ({ signature, publicKey }), validUntilLedger, networkPassphrase)` from `@stellar/stellar-sdk` builds.
3. Submit that entry as base64 in `signedAuthEntry`.

The SDK does this, and checks the entry against the order the user was shown before the wallet is asked anything:
```ts
import { Sluice, signOrder } from "@sluice/sdk";
const sluice = new Sluice("https://…");
const cfg = await sluice.ordersConfig();
if (!cfg.enabled) return;                                       // not offered here
const p = await sluice.prepareOrder({ account, assetIn, assetOut, amount: "100" });
if (!p.solverWillFill) return show(p.explained.message);        // nothing was prepared
// show p.summary (pay / receiveAtLeast / expected) and let the user confirm, then:
const signed = await signOrder(
  p,
  (preimage, { networkPassphrase, address }) => kit.signAuthEntry(preimage, { networkPassphrase, address }), // returns { signedAuthEntry, signerAddress }
  { settleContract: cfg.settleContract },
);
const { hash } = await sluice.submitOrder({ orderId: p.orderId, order: p.order, signedAuthEntry: signed });
const done = await sluice.waitForOrder(hash);                   // SUCCESS with .received, or FAILED with .explained
```
`signOrder` refuses to ask the wallet when the entry is not exactly `fill(order)` with the shown order, an optional `trust` for the output asset and the exact input transfer to the contract (a server that displayed one order and wrapped another is caught here), when the wallet answers as another account, or when the signature does not verify against `sha256(preimage)`.

**SDK versions.** The SDK and the API use `@stellar/stellar-sdk` 14, whose `authorizeEntry` handles only `SOROBAN_CREDENTIALS_ADDRESS` (it silently returns any other credentials kind unsigned, and has no `buildAuthorizationEntryPreimage`). The server therefore issues legacy address credentials, which every wallet that supports `signAuthEntry` understands, and `signOrder` refuses anything else instead of returning an unsigned entry. SDK 17 (pulled in by the wallet kit in the web app) has a different `authorizeEntry` and the newer credentials kinds; do not hand it these entries. It would be the next step if wallets start demanding `address-v2`. `signOrder` loads SDK 14 on first use (a dynamic import), so a page that never signs an order does not load it.

### Signing tier 2: a transaction
Some wallets cannot `signAuthEntry` but can `signTransaction`. For them the user is the **transaction source** and pays the fee (the fill costs the solver only its hedge). The one operation is still `settle.fill(order, solver, amount_out)`, so the contract is unchanged; only who authorises what differs:

- the **user's** authorisation is source-account credentials: the user's signature on the transaction is the signature over the order and the exact input transfer (and the trustline, when the order asks for it);
- the **solver's** authorisation (`solver.require_auth()`, covering `fill(order, solver, amount_out)` and the one payment `token_out.transfer(solver, user, amount_out)`) is an address entry that the solver service signs *when it prepares the transaction*. It fixes the order, the solver and the amount, and expires at `tx.validUntilLedger`.

`POST /v1/orders/prepare-tx` takes the same body as `prepare` and returns, in place of `authEntry`:
```json
{ "solverWillFill": true, "orderId": "954654993.53be…", "order": { "…": "as in prepare" },
  "summary": { "pay": "100.0000000", "receiveAtLeast": "95.2262374", "expected": "95.4654993", "networkFee": "0.0140769" },
  "tx": { "xdr": "AAAAAg…", "hash": "08b6…", "source": "G…", "validUntilLedger": 5577282, "maxTime": 1762379600, "networkPassphrase": "Test SDF Network ; September 2015" } }
```
`tx.xdr` is the unsigned envelope, `hash` is the hash the user's signature will not change, `networkFee` is the XLM fee the user pays. A decline has the same `solverWillFill: false` shape as `prepare`. `POST /v1/orders/submit-tx` `{ orderId, order, signedTx }` returns `{ hash, status }` like `submit`; poll `GET /v1/orders/:hash`.

`submit-tx` refuses, with `explained.code`, anything that is not exactly the prepared transaction signed by the user. `BAD_ORDER_ID` (400): the id does not match this order and the solver's entry in the transaction (the id is bound to the solver entry's nonce and expiry and differs from a tier-1 id). `UNSUPPORTED_ENVELOPE` (400): not an envelope, a fee bump, or a muxed source. `WRONG_SOURCE` (400): the source is not the order's account. `TX_MISMATCH` (400): more than one operation, an operation source of its own, another contract or function, another order, solver or `amount_out`, below `min_out`, or a fee far above what was prepared. `BAD_AUTH` (400): the authorisation entries are not exactly the user's source-account entry over this order and the solver's signed entry over this fill (an extra entry, a changed amount, a signature by another key). `BAD_SIGNATURE` (400): not signed by the order's account, or signed for another transaction body. `BAD_TIMEBOUNDS` (400): no expiry, valid for much longer than an order, or not yet valid. `EXPIRED` (410): the order, the transaction or the solver's signature has expired. `BAD_SEQUENCE` (409): the account sent another transaction since prepare (the signed transaction must use the next sequence number); this also stops a replay. Then, as for `submit`: 409 `SOLVER_WILL_NOT_FILL` (price moved, or the breaker), 422 for the transaction as simulated (`ALREADY_USED`, `BELOW_MIN_OUT`, …) or as rejected by the network, 503 `SOLVER_UNAVAILABLE`. The solver service itself sends only a transaction it prepared (it matches the hash against a reservation it saved first), and it hedges a reserved transaction whoever sends it: if the user sends it to the network directly the fill is still hedged.

The SDK mirrors it: `prepareOrderTx`, `signOrderTx(prepared, signTransaction, { settleContract, solver })`, `submitOrderTx`. `signOrderTx` reviews the transaction before the wallet is asked anything (source, one operation, the exact order, solver and amount, both authorisations including the solver's signature, expiry, and that the fee equals the `networkFee` shown), asks `signTransaction(xdr, { networkPassphrase, address })` (SEP-43: it returns `{ signedTxXdr, signerAddress }`), and checks that what comes back is the same transaction with the user's valid signature.
```ts
const cfg = await sluice.ordersConfig();
if (cfg.enabled && cfg.signing.tiers?.includes("tx")) {
  const p = await sluice.prepareOrderTx({ account, assetIn, assetOut, amount: "100" });
  if (!p.solverWillFill) return show(p.explained.message);
  // show p.summary (pay / receiveAtLeast / expected / networkFee), then:
  const signedTx = await signOrderTx(p, (xdr, o) => kit.signTransaction(xdr, o), { settleContract: cfg.settleContract, solver: cfg.solver });
  const { hash } = await sluice.submitOrderTx({ orderId: p.orderId, order: p.order, signedTx });
  const done = await sluice.waitForOrder(hash);
}
```
Tier 2 costs the user a fee and a sequence number, and the solver's signature is out there (valid until `validUntilLedger`) as soon as `prepare-tx` answers: it commits the solver to pay `amount_out` for this order to whoever completes the transaction with the user's signature, which is why the window is short, the solver saves the reservation before answering, and hedges it however it is sent.

### The solver service
```
wallet ─ SDK ─▶ API  (/v1/orders/*)  ──HTTP + bearer token──▶  solver service ─▶ Soroban RPC, Horizon
                 no key, no state      timeouts, clean 503      key + state dir    fills, hedges, retries
                 orderId is a MAC      if it is down            (one per key)
```
`packages/solver` is both the solver library and a small Hono service around it. Build and run it with `pnpm build && pnpm solver` (`SOLVER_*` in [.env.example](./.env.example)). It owns the solver key, decides whether to fill (with its own Horizon quote, its own inventory and its own policy: the API's price is a courtesy, never trusted), sends fills, hedges them, retries failed hedges and keeps the durable state. It starts only with a valid configuration, a token of at least 32 characters, a state directory (or the explicit `SOLVER_ALLOW_MEMORY_STATE=1`), and a non-public network passphrase; the public network is refused here too, with no override.

Every route, `/health` included, needs `Authorization: Bearer <SOLVER_AUTH_TOKEN>` (compared in constant time, after hashing both sides, so neither the content nor the length of the token leaks through timing). A request the solver understood answers 200 with a `kind` that says what happened; HTTP errors mean the request was unusable (400, 413) or unauthenticated (401).

| Route | Purpose |
|---|---|
| `GET /health` | Address, network, contract, whether it is accepting (the circuit breaker), number of open positions, whether the recovery loop runs, where the state lives |
| `POST /fill` `{ order, assetIn, assetOut, amountOut, signedUserEntry, quoteOut? }` | Tier 1. Re-checks the entry and its signature, simulates with the user's entry in place, prices the hedge itself, saves the fill, then signs and sends. `kind`: `sent` (`hash`, `PENDING` or `DUPLICATE`), `refused` (`CIRCUIT_BREAKER` or `SOLVER_WILL_NOT_FILL` with `reasons`), `invalid`, `sim_failed`, `rejected`, `busy`, `error`. Amounts are integer strings of stroops |
| `POST /prepare-tx` `{ order, assetIn, assetOut, amountOut, validForSec }` | Tier 2. Builds the user-sourced transaction, signs only the solver's entry, saves the reservation, returns `{ kind: "prepared", tx }` |
| `POST /submit-tx` `{ signedTx }` | Tier 2. Sends a transaction it prepared, once the user has signed it |
| `GET /status/:hash` | `{ known, hedge }` for a fill or reservation |
| `GET /exposures`, `POST /exposures/:id/retry` `{ maxLossBps? }`, `POST /exposures/:id/clear` | Operator view and the two actions only a person should take: retry now (optionally accepting a larger, explicit loss) or clear a position that was hedged by hand |

One service per key: the sequence numbers of the solver account are handed out by this process, so two processes on one key will collide. The API reaches it with `RemoteSolver` (a timeout on every call, and every failure becomes `SolverUnavailable`, which the API turns into `503 SOLVER_UNAVAILABLE`).

### Recovery and state
**Policy** (`packages/solver/src/recovery.ts` has the full text). After a fill the solver holds `amountIn` of the asset it has not sold. It hedges at once at the plan the profit check approved. If that does not land it may re-quote and retry, at most `maxRetries` more times per cycle, and never blindly: each retry takes a fresh quote and must keep the realised result inside the loss bound (`maxLossBps` of the originally quoted proceeds, counting what was paid out, the fees and the fee of every failed attempt), with the bound itself as the on-chain `destMin`. If no retry is acceptable (no path, outside the bound, budget spent) the solver does **not** dump at any price: it leaves the position open, records it, and the **circuit breaker** trips: no new fill (and no new `prepare`) while open positions are worth more than `maxUnhedgedExposureOut` (default 0). The background **recovery loop** (a stoppable, unref'd timer) then retries each open position on a doubling backoff, at most `RETRY_MAX_CYCLES` times; after that the position is `ABANDONED`: it stays open, the breaker stays tripped, and only an operator (`/exposures/:id/retry` with an explicit `maxLossBps`, or `/clear` after hedging by hand) moves it. An unknown outcome (a timeout, a lost response) is never retried blindly: it is resolved by the transaction hash, then by the solver's balance of the asset, so a hedge is never sent twice.

**State** is one JSON document in `SLUICE_STATE_DIR` (mode 0600), written atomically (temporary file, `fsync`, rename, `fsync` of the directory) behind a two-method `StateStore` interface, so a database can replace it without touching the rest. It holds the open positions, one record per fill (hedge status, attempts, the plan needed to hedge it later), and which signatures were used. A fill is saved **before** the network can see it, and a hedge's hash is saved before it is sent. On start the solver reloads all of it: open positions go back into the ledger (so the breaker is as tripped as it was), fills not yet seen landing are tracked again, a hedge that was in flight is settled by its hash before anything else is sent, and the recovery loop resumes. A state file that exists but cannot be read stops the solver instead of starting it empty, because that would forget open positions. There are no secrets in it.

Which signatures were used: the contract consumes the nonce on chain, so a replay never moves funds twice. The solver additionally remembers `(user, nonce)` of every fill it sent, so submitting the same signed entry again (after a timeout, a crash, a double click) is answered with the first fill's hash, status `DUPLICATE`, instead of a second simulation and send. Nothing else in the API is stateful: `orderId` is a MAC.

### Configuration
Required for either mode: `ORDERS_SETTLE_CONTRACT`, `ORDERS_RPC_URL`, `ORDERS_HORIZON_URL`, `ORDERS_NETWORK_PASSPHRASE`, `ORDERS_MAC_SECRET`. Remote mode (production) adds `ORDERS_SOLVER_MODE=remote`, `ORDERS_SOLVER_URL`, `ORDERS_SOLVER_TOKEN`, `ORDERS_SOLVER_ADDRESS`; local mode (development) adds `ORDERS_SOLVER_MODE=local` and `ORDERS_SOLVER_SECRET` (with neither mode set, a secret means local and a URL means remote). Pricing knobs (`ORDERS_MAX_ORDER_IN`, `ORDERS_MIN_PROFIT_BPS`, `ORDERS_HEDGE_SLIPPAGE_BPS`, `ORDERS_IMPROVEMENT_BPS`, `ORDERS_MIN_DEADLINE_BUFFER_SEC`, `ORDERS_FEE_OUT_PER_XLM`) set what the API quotes; the service has its own `SOLVER_*` copies, which are authoritative. In local mode the recovery settings are `ORDERS_MAX_RETRIES`, `ORDERS_MAX_LOSS_BPS`, `ORDERS_MAX_UNHEDGED_OUT`, `ORDERS_RETRY_*` and `SLUICE_STATE_DIR`. The solver account needs XLM for fees, a trustline and an inventory of the asset it pays out, and a trustline for the asset it receives. `pnpm w4:orders-api-testnet` deploys everything on testnet with throwaway keys and drives the tier-1 flow through the SDK in local mode; `w5` and `w6` do the same against a real solver service process.

### Limits of this prototype
- Testnet only, unaudited contract, mainnet refused in code (API, service and node each check).
- One solver key means one transaction sequence: fills and hedges of one key are serialised by one process. Run exactly one solver service per key; two processes sharing a key will collide.
- Hedges run one at a time, and the double-hedge guard assumes the solver's balance of the asset sold is made of its open positions plus the one being hedged. A solver account that also trades the same asset by other means will confuse it.
- The loss bound and the retry limits are policy defaults, not derived. `maxLossBps` is measured on the quote, in the asset paid out, with fees at an assumed `FEE_OUT_PER_XLM` (testnet has no XLM market).
- The solver's own state file is the source of truth for open positions; it is not replicated. Lose the disk and the positions are known only by the solver's balance. Back up `SLUICE_STATE_DIR`.
- The service's bearer token authenticates the API to the solver; it is not a signer and it does not make a public listener safe. Run the service on a private network, and put the key behind a signer or HSM before it holds anything of value.
- Tier 2: the solver's signature is valid for the whole window (`validUntilLedger`), so a prepared-and-abandoned transaction commits the solver until then (a reservation is saved and watched, and expires unused). Prepare requests cost the solver a simulation each and open reservations are capped at 200; put a rate limit in front of any public instance.
- The user's signature binds the order, not the solver or the exact payout: any amount at or above `min_out` is valid, and the user's protection is `min_out`. The solver re-checks its own profit at submit and may decline (`409`).
- Prices come from Horizon (maintenance mode; fresh offers can be a few ledgers late). Fees are converted to the output asset at `ORDERS_FEE_OUT_PER_XLM`, an assumption: testnet has no market to read.
- `prepare` and `submit` do real work per request (an RPC simulation or three and Horizon reads) and have no rate limit of their own. Put one in front of any public instance.
- Not exercised against a real wallet or browser: the signing paths are verified with a keypair behind callbacks shaped like `signAuthEntry` and `signTransaction`. The Settle tab uses tier 2 for wallets that cannot `signAuthEntry` (xBull, Albedo, LOBSTR, Rabet, Ledger, Trezor) whenever `GET /v1/orders/config` lists `"tx"` in `signing.tiers`: the review screen shows the network fee the user pays, and the app reviews the whole transaction itself (`signOrderTx`) before the wallet is asked. It has been driven only with a test stand-in and mocked servers, never with one of those real wallets (see `docs/WALLET_TEST_PASS.md`).

## Verified on real chains
- **Mainnet, simulation:** Aquarius, Soroswap, Phoenix and Comet builders each produce a transaction whose simulated output equals the live quote to the stroop; Blend deposit simulates. Through the API on 2026-10-08, all four XLM to USDC routes built and simulated for a funded account, the trustline prerequisite appeared for an account without one, and a Blend withdrawal with nothing supplied returned the pool's own error (#1217), now explained in words.
- **Mainnet, read back:** `GET /v1/tx/:hash` on two settled path payments returned `received` equal to the amount Horizon reports for them.
- **Mainnet, wallet handoff:** from the web app a real wallet (Albedo) displayed the Aquarius `swap_chained` call with the reviewed amount and minimum for the connected account. It was not signed.
- **Mainnet, cross-checked:** the Blend rates this API reports matched Blend's own SDK (`@blend-capital/blend-sdk` 3.3.1) for all three reserves of the Fixed V2 pool, to four decimals, on 2026-10-08.
- **Testnet, settled end to end after the signature (`pnpm w0:testnet-flow`, throwaway keys):** the same functions the API runs once a wallet has signed (`parseSignedTx`, `submitTx`, `getTxStatus`, `receivedAmount`, `explainCodes`) settled a trustline, a Classic path payment and a Soroswap swap. For both swaps the received amount read from the transaction equalled the balance change and the quote. A swap with an unreachable minimum failed on chain and was explained as slippage; a stale sequence number was rejected at submit and explained. Example hashes: Classic `d465e5b11203c6178150c0a99552391bacac6fe0f209923ed9731c63153cafe8`, Soroswap `beb84117881e821e2ff3358b2a3bc1fc2321cdbc5e481b54f870f36b2c9c0a74`.
- **Testnet, submitted:** the Sluice contract is deployed at `CCKF6I5Z5LIH7HKB6E5ESF4BLZC3U65HUJ56X2Y4QNG6ZPW6Z5YZMXLQ` (throwaway key, faucet funds, testnet only). A real swap through it into a real Soroswap pool delivered exactly the quoted amount; a two-leg round trip ran in one invocation; the contract held zero of every token afterwards.
- **Testnet, settlement prototype (`pnpm w1:settle-testnet`, throwaway keys):** a user holding Classic asset A, with no trustline for Classic asset C, signed only a Soroban auth entry. A separate solver account built, signed and paid for one transaction that took 100 A and delivered 95 C, creating the user's C trustline in the same invocation (CAP-0073 `trust`). The user sent no transaction. The signature did not authorize a changed order (`Error(Auth, InvalidAction)`), an output below `min_out` was refused, and the contract held zero of both tokens afterwards. Fill transaction `08873d738b16635107664fd769547641031375334bfb5becbbe0e258a8d728e8`. What this does not show: the solver hedging on the Classic DEX (see `w2`..`w5`), a real wallet signing the auth entry, or any mainnet run.
- **Testnet, the transaction-signing tier (`pnpm w6:tx-tier-testnet`, throwaway keys, 2026-11-06):** the API in remote mode (no solver secret) calling the standalone solver service as a separate process; a wallet stand-in that can only `signTransaction`. The transaction on chain is sourced from the user, who paid its fee (0.0121170 XLM charged, 0.0140768 shown as the maximum); the solver sent no fill transaction. The user paid exactly 100 A and received the agreed 95.4679802 C, with the C trustline created in the same invocation. The real network's recording simulation produced the entries the design expects (source-account credentials for the user, an address entry for the solver), with the contract unchanged. Fill `af459540c7df34cd2fdec5538fda6b5a325a3b2b549b2c4f26b6ace272ada96d`, hedge `95d1ce4c76f5f9f7b06042b2c2dd60836fa12349eabd61015e7f4f18732ff436`. Refused by the live API, nothing reaching the chain: unsigned, signed by another key, wrong source, tampered `amount_out`, tampered order, wrong order id, a replay, a stale sequence, an expired transaction; the SDK refused to ask the wallet to sign a summary that promised more, a changed order, another solver, or an expired transaction. An earlier run of the same script landed another tier-2 fill (`8a92a7c5c957d908968d309b17fabf1d890af73acb40c663a6ccb9919c44fe9e`) and then stopped on a bug in the script's own checks, which was fixed.
- **Testnet, recovery across a crash (`pnpm w5:recovery-restart-testnet`, throwaway keys, 2026-11-06):** a fill went through API and SDK; the maker cancelled its resting offers on chain while a Horizon proxy (fault injection in the harness, in the style of `w3`) kept serving the old quote, so the hedge was priced and sent into an empty book and failed on chain. The user's fill stayed `SUCCESS`; the hedge went `RETRYING` (bounded: `retries_exhausted` after the attempts, 100 A still held, nothing dumped); the circuit breaker tripped and a new order was refused up front with an explained reason; the exposure and its record were on disk and held no secret. The solver service was then killed (SIGKILL) and the API instance dropped: the API answered `503 SOLVER_UNAVAILABLE` cleanly, kept reporting the fill from the chain, and showed the hedge as `UNKNOWN`. The maker restored the book, the solver service started again on the same state directory: the open exposure and the tripped breaker came back from the store, the recovery loop resumed, the hedge landed, the exposure and the breaker cleared, the solver held no leftover A and the position had been sold exactly once. One run's transactions (fill `b1d1963dbfc0494a628c059e42437da907b57ba69a0fff149d0b31e64ab94086`, two hedges that failed on chain `106de25d4ad60951b1c1bddb88fcc57121c8b98bd52bc3ed7329deb9b2576843` and `1dc53e2c817a4d805743dd7b9699fc0a513c46432947afde787a83a18d02ff2b`, the hedge that landed after the restart `18a519be133c43d5fc1c63637a5c2eeb00fec09bf8c6c8ec41f999bd8f66610d`). What this does not show: a hedge whose response was lost in a real network fault (`w3` injects that; the unit tests cover it), a database store, or more than one open position at a time.
- **Not yet done: a signed transaction settled on mainnet through Sluice.** Everything up to the signature is exercised against mainnet, and everything after it is exercised on testnet. What is missing is one real mainnet settlement per venue (Aquarius, Phoenix, Comet and Blend have no testnet run here) and the web app's own flow with a real wallet. Until each venue has a recorded mainnet transaction hash here, treat mainnet execution as unproven.

## Honest limits
- The server never signs. The web app needs a browser wallet: Freighter (listed as Varial in wallet kit 2.8), xBull, Albedo, LOBSTR, Rabet or Hana. Settlement orders are signed as an authorisation entry by wallets that support it (Freighter) and as a transaction, with the user paying the fee, by the others when the server offers the transaction tier. WalletConnect (mobile wallets) appears when the app is built with `VITE_WALLETCONNECT_PROJECT_ID` set to a Reown project id; that path loads and lists correctly with a placeholder id but has not been paired with a real phone wallet.
- If the wallet reports that a different account signed than the one connected (the user switched accounts inside the wallet), the app refuses the signature and says so. Wallets that do not report the signer are caught by the network instead (`txBadAuth`, explained).
- The Sluice contract is unaudited and not on mainnet. Same-layer multi-venue chains (for example Phoenix then Comet) only appear when `SLUICE_ROUTER_CONTRACT` is set, and have only been exercised on testnet with Soroswap. Leave it unset on mainnet.
- Cross-layer routes are two transactions: Soroban allows one operation per transaction (PRD section 7.1). If the second does not go through you hold the intermediate asset. The web app remembers a half-finished route in the browser and offers finish, unwind or keep; there is no server-side state and no automatic unwind.
- Phoenix and Comet are single-pool venues quoted from on-chain state. Phoenix pools are small, so large sizes return no route. Only the Blend BLND/USDC Comet pool is configured. `simulate_swap` on Phoenix is not proof a swap executes (pools whose `stake_contract` equals their own address are skipped); `/v1/build` simulates the real transaction. A venue that quotes but does not execute can be switched off with `DISABLED_VENUES`.
- Vaults are Blend lending pools only. Sluice supplies and withdraws non-collateral positions; it shows collateral posted elsewhere but does not move it. DeFindex is not supported (`/v1/deposit` returns 501). A zap is a swap, then a deposit of the amount actually received.
- Blend rates shown are the pool's rate curve at current utilisation, less the backstop share: a reading, not a promise.
- Stablecoin scores use live Horizon peg and executable depth plus issuer flags, for USD-pegged assets only. The reference asset (USDC) is not scored for peg or depth because prices are measured in it. Holder concentration is not measured. Weights are uncalibrated. PYUSD's issuer could not be confirmed against its `stellar.toml` from the checking machine (HTTP 403); see `DEFAULT_SCORED_ASSETS`.
- Asset icons load from the hosts the public lists name. Some refuse embedding; the app shows the asset's initials instead.
- Ranking: a two-transaction route must beat the best atomic route by about 50 bps (`twoStepPenaltyBps`) to rank first. That is a policy default, not derived.
- Not built: split routing across venues, Sushi V3 and Aquarius CLMM specifics.
- The first quote after the server starts is the slowest (new connections to five venues), and on a host with a slow name resolver it can come back with venues missing. The server caches name lookups in the process and resolves its upstream hosts at start; the web app says when venues have not answered and asks again by itself.
- The public RPC endpoint has unknown rate limits and each quote makes about 10 to 20 calls. Set `RPC_URL` to your own provider before real traffic.

## Deploy
One Node process serves everything: `pnpm build && pnpm start`.

On Vercel the web app is static and the API is one function (`api/index.js`). This configuration has been exercised locally but **not yet deployed**; expect to adjust it on the first preview.
```bash
vercel link
vercel env add RPC_URL production      # your own Stellar RPC provider
vercel deploy                          # preview first; `vercel deploy --prod` when it checks out
```
Rate limiting is a firewall rule, staged in log mode first and published by a person after reviewing the traffic it matches:
```bash
vercel firewall rules add "Sluice quotes" \
  --condition '{"type":"path","op":"pre","value":"/v1/quote"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 120 --rate-limit-keys ip --rate-limit-action log --yes
vercel firewall rules add "Sluice builds and submits" \
  --condition '{"type":"path","op":"pre","value":"/v1/"}' --condition '{"type":"method","op":"eq","value":"POST"}' \
  --action rate_limit --rate-limit-window 60 --rate-limit-requests 60 --rate-limit-keys ip --rate-limit-action log --yes
vercel firewall diff && vercel firewall publish --yes
```
The security headers in `vercel.json` repeat `SECURITY_HEADERS` in `packages/api/src/app.ts`: change both together.

## License
MIT. See [LICENSE](./LICENSE).

## Licensing note
Phoenix's contracts are GPL-3.0 and StellarBroker's router contract is MIT. This repo calls Phoenix on-chain through its public interface and copies no code from either; the adapter call shapes were re-verified against the deployed contracts. Blend's pool status rules, rate curve and error numbers were read from `blend-contracts-v2` and re-implemented, not copied.
