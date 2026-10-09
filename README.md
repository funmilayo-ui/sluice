# Sluice

Open-source router for Stellar liquidity across Classic (SDEX, Classic pools) and Soroban (AMMs, vaults). It tells you which routes are atomic and which are not, and lets you execute them from your own wallet. See [PRD.md](./PRD.md) for scope, evidence and open questions.

Mainnet only. Non-custodial: the server builds and simulates transactions and relays the ones your wallet has signed. It never holds a key.

## Layout
| Path | What |
|---|---|
| `packages/core` | Quote sources (Horizon paths, Aquarius, Soroswap, Phoenix, Comet), router, atomicity classifier, stablecoin scoring, execution builders (Classic path payment, Aquarius, Soroswap, Phoenix, Comet, Sluice router contract, Blend supply and withdraw, trustline), `planExecution`, simulation via `prepare()`, submit and status over Stellar RPC, settled-amount decoding, plain-language error explanations, public asset lists, Blend pool reads |
| `packages/api` | Hono REST API (below). Serves the built web app when it exists |
| `packages/sdk` | Typed client for every endpoint, plus `waitForTx` and `unwind` |
| `apps/web` | Vite + React app: wallet connect, live routes, review, sign, submit, status; two-transaction routes with resume and unwind; Blend deposit, zap and withdraw; stablecoin health |
| `api/index.js`, `vercel.json` | The same API as one Vercel function, with the web app on the CDN |
| `contracts/router` | Soroban router: atomic multi-leg swaps over Soroswap routers and Phoenix/Comet pools, non-custodial, min-out on measured balance delta. Not used on mainnet (unaudited) |
| `scripts` | Read-only mainnet probes and a testnet-only settlement script (`w0:*`) |

## Run
```bash
pnpm install
pnpm build                         # packages, then the web app into apps/web/dist
pnpm start                         # API and web app on http://localhost:8787
pnpm test                          # 154 TypeScript tests (core 70, api 45, sdk 12, web 27)
PW_CHANNEL=chrome pnpm e2e         # 12 browser checks on desktop and phone, against live mainnet data
pnpm w0:testnet-flow               # settles real testnet swaps with throwaway keys (post-signature path)
cd contracts && cargo test         # 13 contract tests
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

Cross-layer routes are two transactions. `/v1/build` pre-builds leg 1 only; after it settles, quote the second pair for the `received` amount and build that. The web app and `sdk.unwind()` do this for you.

## Verified on real chains
- **Mainnet, simulation:** Aquarius, Soroswap, Phoenix and Comet builders each produce a transaction whose simulated output equals the live quote to the stroop; Blend deposit simulates. Through the API on 2026-10-08, all four XLM to USDC routes built and simulated for a funded account, the trustline prerequisite appeared for an account without one, and a Blend withdrawal with nothing supplied returned the pool's own error (#1217), now explained in words.
- **Mainnet, read back:** `GET /v1/tx/:hash` on two settled path payments returned `received` equal to the amount Horizon reports for them.
- **Mainnet, wallet handoff:** from the web app a real wallet (Albedo) displayed the Aquarius `swap_chained` call with the reviewed amount and minimum for the connected account. It was not signed.
- **Mainnet, cross-checked:** the Blend rates this API reports matched Blend's own SDK (`@blend-capital/blend-sdk` 3.3.1) for all three reserves of the Fixed V2 pool, to four decimals, on 2026-10-08.
- **Testnet, settled end to end after the signature (`pnpm w0:testnet-flow`, throwaway keys):** the same functions the API runs once a wallet has signed (`parseSignedTx`, `submitTx`, `getTxStatus`, `receivedAmount`, `explainCodes`) settled a trustline, a Classic path payment and a Soroswap swap. For both swaps the received amount read from the transaction equalled the balance change and the quote. A swap with an unreachable minimum failed on chain and was explained as slippage; a stale sequence number was rejected at submit and explained. Example hashes: Classic `d465e5b11203c6178150c0a99552391bacac6fe0f209923ed9731c63153cafe8`, Soroswap `beb84117881e821e2ff3358b2a3bc1fc2321cdbc5e481b54f870f36b2c9c0a74`.
- **Testnet, submitted:** the Sluice contract is deployed at `CCKF6I5Z5LIH7HKB6E5ESF4BLZC3U65HUJ56X2Y4QNG6ZPW6Z5YZMXLQ` (throwaway key, faucet funds, testnet only). A real swap through it into a real Soroswap pool delivered exactly the quoted amount; a two-leg round trip ran in one invocation; the contract held zero of every token afterwards.
- **Not yet done: a signed transaction settled on mainnet through Sluice.** Everything up to the signature is exercised against mainnet, and everything after it is exercised on testnet. What is missing is one real mainnet settlement per venue (Aquarius, Phoenix, Comet and Blend have no testnet run here) and the web app's own flow with a real wallet. Until each venue has a recorded mainnet transaction hash here, treat mainnet execution as unproven.

## Honest limits
- The server never signs. The web app needs a browser wallet: Freighter, xBull, Albedo, LOBSTR, Rabet or Hana. WalletConnect (mobile wallets) appears when the app is built with `VITE_WALLETCONNECT_PROJECT_ID` set to a Reown project id; that path loads and lists correctly with a placeholder id but has not been paired with a real phone wallet.
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

## Licensing note
Phoenix's contracts are GPL-3.0 and StellarBroker's router contract is MIT. This repo calls Phoenix on-chain through its public interface and copies no code from either; the adapter call shapes were re-verified against the deployed contracts. Blend's pool status rules, rate curve and error numbers were read from `blend-contracts-v2` and re-implemented, not copied.
