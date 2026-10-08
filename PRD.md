# Sluice: Product Requirements Document

**Status:** v1.0 (scope locked, pending week-0 spike results in §12) · **Date:** 2026-10-07 · **Owner:** TBD
**Working name:** Sluice (availability of name, domain and GitHub org not yet checked)
**One-liner:** An atomicity-aware liquidity router for Stellar that spans Classic (SDEX, Classic pools) and Soroban (AMMs, vaults), and is aware of stablecoin quality and vault yield when choosing a route.

> Evidence legend used throughout: **[V]** verified by adversarial voting against a primary source, **[S]** single-source or self-reported (SCF proposal, README), **[I]** inference or absence-of-evidence, **[U]** unverified. Section 12 lists everything still open.

---

## 1. Problem

Stellar liquidity lives in two incompatible layers:

1. **Classic**: the SDEX orderbook, Classic liquidity pools, and path payments (strict-send / strict-receive). Core picks the route hop by hop and the caller cannot force a venue. [V]
2. **Soroban**: AMMs (Soroswap, Aquarius incl. CLMM beta, Phoenix, Sushi V3, Comet), lending (Blend), and yield vaults (DeFindex, The Strategists, XCCY).

A Soroban transaction may contain exactly one operation (`InvokeHostFunctionOp`, `ExtendFootprintTTLOp` or `RestoreFootprintOp`). [V] So a Classic leg and a Soroban leg **cannot** be atomic in one transaction. Existing aggregators sidestep this by staying inside Soroban for atomic execution and treating Classic as a quote benchmark. [S] The result: users and integrators either miss Classic depth, miss Soroban depth, or take unmanaged two-step risk.

On top of that, routing is blind to two things users care about on Stellar specifically:
- **Which stablecoin / issuer is the right one** to route through (peg, depth, issuer concentration, anchor reliability).
- **Where the output should end up**: swapping into a yield vault today is a manual multi-step flow.

## 2. Goals and non-goals

### Goals
- G1. Best-execution quotes across SDEX, Classic pools and Soroban AMMs, in one API.
- G2. **Explicit atomicity classes** on every route: fully atomic (Soroban-only, incl. SAC-wrapped assets), or two-step with quantified risk and a safe-fail path.
- G3. **Stablecoin-aware routing**: rank routes using peg deviation, depth, and issuer/anchor health, not price alone.
- G4. **Zap into vaults**: one flow from any asset into a DeFindex/Blend vault position.
- G5. Public API + SDK usable by wallets, so Sluice is infrastructure, not only a UI.
- G6. Fundable under SCF Build (up to $150K, tranche-paid) with measurable milestones.

### Non-goals (v1)
- Not a generic portfolio tracker or chain-stats dashboard (already covered by Dig, Untangled OctoPos, Dune). [V]
- Not a new AMM, new vault protocol or new stablecoin.
- Not a cross-chain bridge. Bridging (WOWMAX scope) is out; integration with Allbridge is a later option.
- Not a custodial product. Non-custodial only.

## 3. Competitive landscape

### 3.1 Pillar A: aggregators
| Project | Funding | What it does | Dual-layer? |
|---|---|---|---|
| **LumAgg** | SCF#44, $90K, solo dev [V] | Routes Soroswap, Aquarius (volatile/stable/CLMM), Phoenix, Sushi V3, Comet via BFS graph + atomic mainnet contract [V] | **Ambiguous.** Repo says Classic is a per-quote benchmark/fallback, not a routable edge; verifier votes on this were split (0-3, 1-2, 2-1) [S] |
| **WOWMAX** | SCF#43, $98.6K [V] | Proposes modified A* across SDEX, Classic path payments + pools, Soroban AMMs, plus bridging to 20+ networks [S] | Proposed. Delivery (MVP Jun / testnet Jul / mainnet Aug 2026) **unverified** |

| **StellarBroker** (spike result) | $150K in SCF awards per secondary sources [S] | Org README lists Stellar DEX orderbook, Classic AMMs, Soroswap, Aquarius; architecture documents a Transaction Submitter that simulates and submits route legs in parallel [V coverage / S execution]. Only 4 public repos (router-contract in Rust, client, ui, .github); **matcher/quote engine is closed-source**. Router-contract last pushed 2026-07-26 | **Yes, the one documented dual-layer precedent.** Classic-leg execution not independently confirmed (verifier vote 1-2); no live swap tested |
| **Soroswap aggregator** (spike result) | n/a | Mainnet adapters registered and unpaused for Soroswap, Phoenix, Aqua (all Soroban AMM routers), checked 2026-09-17 at ledger 64464571 [V]. No Classic adapter shown, but Classic absence is **unproven** (both inference claims refuted) | Not shown |
| **LumAgg code check** | | README (verbatim): `classic_dex` is "Benchmark only"; Classic quoted via Horizon PathPayment and used as fallback for tokens that exist only on the native DEX; contracts/aggregator only calls Soroban pool contracts [V graph exclusion]. Rust source not fully read | No (Classic is not a graph edge) |
| **StellarRoute** (github.com/mathstickz/StellarRoute) | n/a | Community aggregator repo surfaced in search; not evaluated [U] | Unknown |

**Takeaway:** dual-layer *quoting* is not unique. Do not pitch Sluice as "the first aggregator" or "the first dual-layer router". StellarBroker already claims dual-layer coverage with a **closed-source** engine, so Sluice's openness, atomicity transparency and B/C fusion are the differentiators, not coverage alone.

### 3.2 Pillar B: vaults and yield
- **DeFindex / The Strategists** (PaltaLabs, $150K Build, SCF#42): vault/strategy layer over Blend, Aquarius, Soroswap; wallet integrations live (self-reported, ~$1.38M TVL ATH). [V]/[S] Sluice should integrate, not compete.
- **XCCY Phase 2** ($141.1K, SCF#43): fixed-rate yield vaults on Blend. [V]
- **Gap:** no verified team aggregating **tokenized RWA / treasury funds** (e.g. Franklin BENJI, Ondo/USDY). [I]

### 3.3 Pillar C: stablecoins
- **Bluechip** ($136.5K, SCF#44): stablecoin ratings and analytics, wallet rating tool, activity dashboard (supply, issuance, holders, tx counts). No routing, peg-depth or liquidity scope. [V] Candidate data partner.
- **Stabble** (SCF submission recYIEeYnMBmuYBmT): Soroban-native stablecoin liquidity layer with atomic multi-hop swaps via cross-contract calls; no mention of SDEX or Classic pools. Roadmap: MVP 15 Jul 2026, testnet 15 Sep 2026, mainnet 3 Nov 2026; shipping unchecked. [V description] This is a **stablecoin liquidity venue**, which Sluice should integrate as a route source, not compete with. Whether it adds peg/issuer-aware routing is unknown.
- No funded stablecoin-aware *router* found. [I]

### 3.4 Adjacent (do not rebuild)
Dig ($75K, SCF#43, portfolio + alerts), Untangled OctoPos (portfolio/risk explorer), Dune (generic analytics, official docs), Sorscan (explorer), StellarExpert / StellarChain. [V]

### 3.5 Is anyone fusing A + B + C?
None found. [I] Evidence is absence from SCF pages and web search; GitHub, DoraHacks, Devpost and Drips Wave repos were not exhaustively checked.

## 4. Positioning

> **Sluice is the router that knows which layer a trade lives on, tells you what is and isn't atomic, picks the stablecoin and venue that are actually healthy, and can land the result in a vault.**

Differentiators, in priority order (revised after the spike; StellarBroker removes coverage as a moat):
0. **Open source, auditable routing** against a closed-source incumbent.
1. **Atomicity-aware cross-layer routing** (core moat; hard problem, see §7).
2. **Stablecoin-quality-weighted routing** (peg, depth, issuer/anchor health).
3. **Zap-to-vault** (swap + deposit as one user flow, atomic where Soroban-only).
4. ~~RWA routing~~ dropped; permissioned assets cannot be touched by a permissionless router (§10). RWA *analytics* (read-only) stays a possible later add.

## 5. Users and use cases

| Persona | Need | Sluice delivers |
|---|---|---|
| Wallet developer (e.g. Beans-style wallets) | Single quote + execute API better than any one layer | Router API + SDK |
| Power trader / market maker | Best price across orderbook and AMMs for large size | Split routes, depth-aware quotes |
| Stablecoin user / treasury | Swap USDC/EURC/PYUSD/USDY/regional stables safely | Peg- and issuer-aware routing, warnings |
| Yield user | Get from any asset into a vault in one step | Zap flow |
| Anchor / issuer | Visibility of how their asset routes | Route-share and depth analytics (later) |

## 6. Scope

### 6.1 MVP (target: first SCF tranche)
- Quote engine over: SDEX orderbook, Classic pools (via Horizon `/paths` or equivalent), Soroswap, Aquarius, Phoenix. (Sushi V3 and Comet added post-MVP.)
- Route classifier: `ATOMIC_SOROBAN`, `CLASSIC_ONLY` (single path-payment op, atomic), `TWO_STEP` (Classic + Soroban, non-atomic).
- Execution: atomic Soroban route via aggregator contract or router calls; Classic-only via native path payment; two-step with pre-flight simulation and min-out guards.
- Public REST API + TypeScript SDK; testnet then mainnet.
- Minimal web app: quote, route breakdown with atomicity badge, execute.

### 6.2 v1
- Stablecoin scoring service (peg deviation, pool depth, issuer concentration, anchor SEP health) feeding route ranking.
- Zap-to-vault: swap into DeFindex/Blend vault deposit as one flow.
- Route-quality analytics (realised vs quoted, vs best alternative).

### 6.3 Later
- ~~RWA/treasury fund routing~~ **Dropped from roadmap:** BENJI is KYC-gated (see §10). Revisit only as an issuer-partnered, allowlisted integration.
- Anchor on/off-ramp aware routing.
- Fee/resource analytics per route (CPU, footprint, rent).
- Sushi V3, Comet, Aquarius CLMM full tick coverage.

## 7. Technical design

### 7.1 Core constraint and design response
- Single-operation rule for Soroban transactions [V] means no Classic+Soroban atomic bundle.
- **Atomic path A (Soroban-only):** all legs via contracts, multi-hop and splits inside one `InvokeHostFunctionOp`; Classic assets participate through their **SAC (Stellar Asset Contract)** wrappers. Cross-contract calls inside one invocation are atomic. [V]
- **Atomic path B (Classic-only):** a native `PathPaymentStrictSend/Receive` (single op). Cannot force venue. [V]
- **Two-step path C (cross-layer):** Tx1 on one layer, Tx2 on the other. Non-atomic. Mitigations: (a) pre-flight simulate both legs, (b) per-leg min-out, (c) intermediate asset held in user's account only (no custody), (d) clear UI/API risk disclosure, (e) optional "resume/unwind" flow if leg 2 fails.
- **Spike result (Q2, medium confidence):** a Soroban contract cannot consume SDEX or Classic pool liquidity directly. Official example page (soroban-examples v23.0.0): "Soroban liquidity pools are exclusive to Soroban and cannot interact with built-in Stellar AMM liquidity pools". Classic assets enter Soroban only as SAC-wrapped balances; no DEX host function was found. Classic liquidity is reached via `PathPaymentStrictSend/Receive`, which select per hop between SDEX and Classic pools at protocol level (CAP-38); Horizon `/paths/*` only quotes. [V on docs] **Caveat:** no CAP-0046/0050+ text or protocol 23/24/25 release notes were retrieved to prove the absence of such a host function; confirm in week 0.
- **Design consequence:** two execution paths, Classic (path payments) and Soroban (contracts). A contract-only atomic route cannot include Classic legs. Stabble-style Soroban-native venues stay atomic within Soroban.
- **How StellarBroker may do it is unknown.** Its Transaction Submitter simulates and submits legs in parallel (same ledger), consistent with separate transactions rather than one atomic bundle. Test with a live mainnet swap in week 0.

### 7.2 Components
1. **Indexer / state cache**: pool reserves, CLMM ticks, orderbook snapshots, vault share prices.
2. **Quote engine**: graph pathfinding with split optimisation; BFS/A*-style over combined graph with layer-tagged edges.
3. **Route classifier**: tags each route with atomicity class and risk.
4. **Executor**: builds transactions; simulates via Stellar RPC `simulateTransaction`; handles auth, footprint, fees.
5. **Aggregator contract** (Rust/Soroban): atomic multi-venue execution for class A.
6. **Stablecoin scoring service**: peg, depth, concentration, anchor health.
7. **API + SDK** and web app.

### 7.3 Data sources and status
| Source | Use | Status / caveat |
|---|---|---|
| Stellar RPC (`simulateTransaction`, ledger/events) | Soroban quoting, simulation, events | Current direction of SDF stack; Horizon moving to deprecation [V] |
| Horizon (`/paths`, orderbook, pools) | Classic quoting | **Maintenance mode**; to be deprecated in favour of RPC and Portfolio APIs, no sunset date [V]. Plan for migration |
| Galexie (v1.0.0, TxMeta to GCS) | Own indexing pipeline | Available [V] (2-1) |
| Hubble (BigQuery) | Historical analytics | Intraday batch, **not real-time** [V]. Not for live peg/uptime |
| Allium | Paid historical/analytics | Stellar v2 from RPC, v1 cutoff 2026-07-10 [V] |
| Goldsky Mirror, OBSRVR | Managed indexing | Listed active [V] (2-1) |
| Mercury | Indexer | **Avoid as a dependency**: team reports downtime, one developer, rebuilt minimal Soroban-only; possible sunset [S] |
| Horizon `/paths/strict-send`, `/paths/strict-receive` | Classic quotes | Documented, no deprecation notice on the paths page [V]; quotes are point-in-time and need limit params; rate limits/auth not verified |
| Soroswap API/SDK, Aquarius API, DeFindex API/SDK, Blend SDK, RPC `simulateTransaction` | Venue quotes, vault data, simulation | **Status, auth and rate limits NOT verified** (spike returned no surviving claims). Week-0 task W0-3 |
| Anchor `stellar.toml` + SEP-6/24/31 endpoints | Anchor health for scoring | Needs own prober; SDF tools are on-demand only [V] |

### 7.4 Security and risk handling
- Non-custodial; user signs every transaction.
- Slippage and min-out enforced on-chain where possible.
- Allowlist of audited venues/vaults; per-venue circuit breakers.
- Oracle/venue compromise precedent exists (Feb 2026 YieldBlox event per ecosystem reporting; DeFindex linkage was **refuted** by verifiers, so do not cite it as such). Treat vault and lending venues as risk-scored.
- Aggregator contract must be audited before mainnet (budget via Soroban Audit Bank or SCF audit allocation; programme details unverified).

## 8. Product requirements

| ID | Requirement | Priority |
|---|---|---|
| R1 | Quote across SDEX, Classic pools, Soroswap, Aquarius, Phoenix | P0 |
| R2 | Every quote returns atomicity class and risk note | P0 |
| R3 | Atomic Soroban multi-hop + split execution | P0 |
| R4 | Classic-only route via single path-payment op | P0 |
| R5 | Two-step cross-layer execution with simulation and min-out | P1 |
| R6 | REST API + TS SDK, documented | P0 |
| R7 | Stablecoin score used in route ranking, with explainability | P1 |
| R8 | Zap into DeFindex/Blend vault | P1 |
| R9 | Route-quality analytics (realised vs quoted) | P2 |
| R10 | RWA/treasury fund routing: **removed from scope** (see §10) | Dropped |
| R11 | Sushi V3, Comet, Aquarius CLMM full coverage | P2 |

## 9. Success metrics
- Price improvement vs best single-layer quote on a fixed benchmark basket (target set after spike).
- % of routes executing atomically; failure rate of two-step routes.
- Quote latency (p95) and uptime.
- Integrations: wallets/dApps using the API; volume routed.
- Stablecoin routing: depeg events where Sluice avoided the unhealthy route.
- Grant milestones delivered on schedule.

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| StellarBroker already claims dual-layer routing; WOWMAX delivery unknown | Coverage is not a moat | Differentiate on open source, atomicity transparency, stablecoin- and vault-aware ranking; week-0 live test of StellarBroker; consider StellarBroker's open `router-contract` as prior art and possible integration/competitor benchmark |
| Two-step routes can fail mid-way | User funds stuck in intermediate asset | Simulation, min-out, unwind flow, clear disclosure; default to atomic routes |
| Horizon deprecation | Classic quoting breaks | Abstract data layer; build on RPC/Galexie; track SDF timeline |
| Hubble/indexer not real-time | Stale peg/health data | Own prober + RPC for live data; Hubble only for history |
| Mercury instability | Indexing outage | Do not depend on it |
| RWA tokens are KYC-gated | RWA routing infeasible | **Confirmed for BENJI [V]:** SDF case study: "wallets without authorization cannot receive the token"; authorization flags, freeze and clawback (5-7s settlement). Drop RWA routing. Ondo USDY and WisdomTree were not checked |
| Solo-team delivery risk (LumAgg precedent is solo) | Schedule | Tight MVP, staged tranches |
| Self-reported SCF data may overstate competitors or delivery | Wrong competitive read | Verify live products before positioning (Q1, Q2) |
| Aggregator contract bug | Loss of funds | Audit, caps, allowlist, staged rollout |

## 11. Funding fit and plan
- **SCF Build**: up to $150K **in XLM** per project, tranche-paid; three tracks: **Open** (community-voted), **Integration** (Pilot panel), **RFP** [V, live awards page]. Which track fits Sluice is **unverified** (claim that it fits Integration was refuted 0-3); default plan is Open, with an eye on Integration if integration-heavy. Do not cite the v7 "$300K lifetime / 10-20-30-40 tranche" figures (refuted 1-2). Comparable awards: LumAgg $90K, WOWMAX $98.6K, Dig $75K, Bluechip $136.5K, XCCY $141.1K, The Strategists $150K. [V]
- Suggested tranches: (1) MVP quote engine + testnet; (2) mainnet atomic router + API/SDK; (3) stablecoin scoring + vault zap + audit.
- **Drips Wave**: monthly, small, pooled per maintainer; suitable for ongoing open-source contributor work (SDK, docs, adapters), not the main product build. [V]
- **Other programs** (Gitcoin, Superteam, OnlyDust, Algora, DoraHacks, Soroban Audit Bank, SDF grants, hackathons): **two research passes returned nothing verified.** Treat as unknown; task W0-5 is a manual check of each program's own site rather than another search pass.

## 12. Open questions: status after spike

| # | Question | Status |
|---|---|---|
| Q1 | Do competitors really route Classic + Soroban? | **Partly answered.** StellarBroker claims it (closed engine, execution unconfirmed). Soroswap aggregator: Soroban adapters only shown, Classic absence unproven. LumAgg: Classic is benchmark/fallback only. WOWMAX, Freighter, Lobstr, xBull, Aquarius router: **unresolved** |
| Q2 | Can a contract consume Classic liquidity? | **Answered (medium confidence): no.** Needs CAP/release-note confirmation (W0-1) |
| Q3 | Venue API status, auth, rate limits | **Unresolved** (W0-3) |
| Q4 | Can a permissionless router touch RWA funds? | **Answered for BENJI: no (KYC-gated).** USDY/WisdomTree unchecked; RWA routing dropped |
| Q5 | Other funding programs | **Unresolved** (W0-5) |
| Q6 | Demand evidence | **Unresolved** (W0-6: interview wallet teams) |
| Q7 | Name/domain/org availability | **Unresolved** (W0-7) |

### Week-0 task list (replaces further desk research; these need hands-on work)
- **W0-1** Read CAP index and protocol 23/24/25 release notes; confirm no Classic DEX host function and that the single-op rule holds.
- **W0-2** Run a small mainnet swap through StellarBroker (and Soroswap, LumAgg) on a pair that needs both layers; inspect resulting transactions on StellarExpert to see whether Classic legs execute and whether they are separate transactions.
- **W0-3** Call each venue API (Soroswap, Aquarius, DeFindex, Blend, Horizon `/paths`, RPC `simulateTransaction`); record endpoints, auth, rate limits, latency, response shape.
- **W0-4** Read `stellar-broker/router-contract` and `Lum-Agg/stellar-dex-agg` Rust source; note reusable patterns and licences.
- **W0-5** Check each funding programme's own site (SCF track fit, Audit Bank eligibility, SDF grants, Superteam, OnlyDust, Algora, DoraHacks).
- **W0-6** Interview 3-5 wallet/dApp teams on stablecoin-aware routing and vault zaps.
- **W0-7** Check "Sluice" on domains, GitHub, X; pick a fallback name.
- **W0-8** Check WOWMAX mainnet status and Stabble's mainnet delivery (due 3 Nov 2026).

### Week-0 results so far (2026-10-07, read-only checks run from a dev machine)
- **W0-4 (partial, done): StellarBroker `router-contract`** (MIT, ~2,094 lines Rust) has adapters for Phoenix, Comet, and three Aquarius pool types (stable, constant, concentrated) plus the adapter trait. A grep for `classic`, `sdex`, `path_payment` and `operation` returned **no hits**. So the *on-chain* router is Soroban-only; any Classic leg would be executed off-contract (separate transaction), consistent with the single-op rule. This does not settle whether the closed-source engine submits Classic path payments, which still needs W0-2. Reusable under MIT as prior art. **LumAgg** repo grep for `classic` in Rust sources also returned nothing; its Classic handling is in the off-chain quote layer. Its licence file was not found.
- **W0-3 (partial, updated 2026-10-08): reachability plus Aquarius and Soroswap router ABIs verified on-chain, Aquarius simulation verified.** Original reachability notes: Horizon `/paths/strict-send` returned live multi-hop quotes (100 XLM to about 19.92 USDC via an intermediate asset) with HTTP 200. Stellar RPC (`mainnet.sorobanrpc.com`) `getHealth` is healthy, latest ledger 64,822,589, **retention window 120,960 ledgers (about 7 days)**, which means longer history needs Galexie/Hubble/an indexer. Aquarius `amm-api.aqua.network/api/external/v1/pools/` is open and returned 360 pools with token addresses and pool types. Soroswap (`api.soroswap.finance`) and DeFindex (`api.defindex.io`) answer HTTP 200 on `/health` but 404 on `/`; **their quote/vault endpoints, auth keys and rate limits are still unread** (need their docs and a key). No rate-limit headers were seen on the Horizon paths response.
- **W0-7 (partial): name.** `github.com/sluice` already exists (HTTP 200), so that org name is taken. `sluice.xyz`, `.finance` and `.fi` did not resolve from here, which is **not** proof they are free. Pick a fallback org name (e.g. `sluice-stellar`) and check registrars directly.
- **Not run (need funds, keys or people):** W0-1 (CAP/release-note read), W0-2 (live mainnet swap), W0-5 (funding sites), W0-6 (interviews), W0-8 (WOWMAX/Stabble status).

**Go / no-go gate after week 0:** if W0-2 shows StellarBroker already executes cross-layer legs well *and* W0-6 shows no demand for stablecoin/vault features, narrow Sluice to an open-source SDK/infra play or pivot to stablecoin analytics (Idea 1 from the first research pass).

## 12b. Implementation status (2026-10-08, code complete for everything buildable without mainnet funds or external keys)

Repo: see `README.md`. Verified by running it:
- **Tests:** TypeScript 74 passing (core 40, API 28, SDK 6); Rust 13 passing; build and typecheck clean; wasm builds with `stellar contract build` (soroban-sdk 28 rejects plain `cargo build`).
- **Quoting (R1):** Horizon `/paths` (Classic), Aquarius `find-path`, and three sources read straight from chain over Stellar RPC with no API key: Soroswap router (`router_get_amounts_out`), Phoenix pools (`simulate_swap`, pools discovered from the factory), Comet (weighted-pool formula from on-chain balances, weights and fee; matched a real swap to one stroop).
- **Execution builders, each proven read-only on mainnet:** for Aquarius, Soroswap, Phoenix and Comet the transaction our code builds simulates to exactly the quoted output (`pnpm w0:aqua-sim`, `pnpm w0:venue-sim`). Blend deposit (`submit` with a `Supply` request) simulates. Classic path payments and trustline (`changeTrust`) builders are unit tested.
- **Real settlement on testnet (throwaway key, faucet funds):** the Sluice contract is deployed (`CCKF6I5Z...MXLQ`). The TS encoding decodes in the deployed contract; each `VenueKind` dispatches to exactly its venue function; a real swap through a real Soroswap testnet pool delivered exactly the quoted amount; a two-leg round trip ran in one invocation (1 XLM to 0.9940066 XLM, the pool fees); the contract held zero of every token afterwards. This is the first evidence the contract works against a real venue rather than a mock. It has not been run against mainnet or against Phoenix/Comet testnet pools.
- **API (R2, R4, R5 partial, R7, R8 partial):** `GET /v1/quote` (with `atomicOnly`), `POST /v1/build` (unsigned, simulated, trustline prerequisites with correct sequence numbers, falls back to the next route when a simulation fails and reports what it skipped), `POST /v1/deposit` (Blend), `GET /v1/stablecoin` (live peg from executable path quotes, depth, issuer flags, explainable score). The optional ranking bias applies to assets named in `SCORED_ASSETS`. Same-layer multi-venue chains are offered only when `SLUICE_ROUTER_CONTRACT` is set.
- **Two-step and recovery (R5):** `planExecution` pre-builds leg 1 and defers the rest with "re-quote from the received amount"; `sdk.unwind()` builds the route back for a stranded intermediate asset. No server-side state and no automatic unwind.
- **Console:** viewed in a real browser with live data; quote, atomicity badges, haircut note, empty and loading states, and "Build unsigned transaction" (shows trustline prerequisites, simulated steps and copyable XDR) all work. Checked at desktop width and at the browser's 500px minimum; not below, not in light mode.
- **Findings made while building (also in README):** a quote is not an execution guarantee (one Phoenix pool quoted but failed every real swap; the real transaction is simulated before signing); the 15 bps non-atomic haircut let a 0.18% raw edge outrank an atomic route (raised to a 50 bps policy default); swapping into a Classic asset needs a trustline (now handled); Comet needs no prior approval when called directly.

**Not done, by design or by missing access:**
- Wallet signing in the console and any mainnet submission. No mainnet deployment and no audit of the contract; one admin key controls its venue allowlist.
- DeFindex vaults (ABI and API access unverified; `/v1/deposit` returns 501). Blend lending pools are the only verified vault.
- Split routing across venues, and Sushi V3 / Aquarius CLMM specifics.
- Phoenix and Comet pools exercised through the contract (only Soroswap was, on testnet). Phoenix and Comet are covered by mainnet simulation of direct pool calls and by mock tests.
- Stablecoin holder concentration (not cheaply available) and weight calibration.
- The week-0 research tasks that need a person: W0-1 (read CAPs), W0-5 (funding sites), W0-6 (wallet-team interviews), W0-8 (WOWMAX and Stabble status).

## 12c. Implementation status, later the same day (2026-10-08)

This supersedes the "Not done" items in 12b that concern the console and execution. `README.md` is the current reference; in short:

- **Web app replaces the console.** Vite + React app with wallet connect (Freighter, xBull, Albedo, LOBSTR, Rabet, Hana; WalletConnect when a Reown project id is configured), live routes, review of the built transaction, sign, submit, status. Two-transaction routes are guided: leg 2 is sized from what leg 1 actually delivered, with unwind or keep, and a half-finished route is offered again after a reload.
- **API grew the execution half:** `POST /v1/submit` (relays a signed transaction), `GET /v1/tx/:hash` (status, amount actually received, explained failures), `GET /v1/account/:id`, `GET /v1/assets`, `GET /v1/asset`, `GET /v1/stablecoins`, `GET /v1/vaults`, `GET /v1/positions`, `POST /v1/withdraw`. `/v1/build` takes a `routeKey` instead of an index, and built transactions are valid for five minutes.
- **R8 (zap) is real for Blend:** deposit, swap-then-deposit of the amount actually received, and withdraw, with pool status and rates read from the pool contract and cross-checked against Blend's SDK.
- **R7 (stablecoin score) is visible:** health badges for USDC, PYUSD, USDGLO and ZUSD; the reference asset is no longer reported as a perfect score.
- **Evidence added:** the post-signature path (submit, status, received amount, failure explanations) settled real Classic and Soroswap swaps on testnet with throwaway keys. A real wallet (Albedo) displayed a mainnet Aquarius swap built by the app; it was not signed.
- **Still not done:** a signed transaction settled on mainnet through Sluice (needs a funded wallet); deployment (a Vercel configuration exists and validates against Vercel's schema but has not been deployed); rate limiting (a firewall rule, added after the project is linked); the contract is still unaudited and off on mainnet; DeFindex, split routing, Sushi V3 and Aquarius CLMM specifics; the week-0 tasks that need a person.

## 13. Milestones (draft)
| Phase | Deliverable |
|---|---|
| Week 0 | Tasks W0-1 to W0-8; go/no-go gate (§12) |
| Weeks 2-6 | Quote engine + classifier on testnet; API alpha |
| Weeks 7-12 | Atomic Soroban executor + contract; Classic path-payment route; web app; mainnet beta |
| Weeks 13-18 | Two-step flow, stablecoin scoring, vault zap |
| Weeks 19-22 | Audit, hardening, SDK docs, wallet integrations |

## Appendix A: refuted or unreliable claims (do not cite)
- LumAgg "purely swaps, no vaults/stablecoin" (refuted 0-3) and several LumAgg dual-layer claims (0-3, 1-2).
- DeFindex affected by Feb 2026 YieldBlox oracle compromise (refuted 0-3).
- The Strategists "routes across Blend, Aquarius, Soroswap" (refuted 1-2).
- Hubble "free public dataset refreshed every 15 minutes" (refuted 0-3); treat Hubble as intraday batch.
- "Official docs list ~12 third-party analytics providers" (refuted 0-3).
- Anchor Directory "has no health metrics" (refuted 1-2; unverified).
- SDF listed indexers as priority in Minimum Viable Ecosystem (refuted 0-3).
- Sorscan "exploration and analytics" description (refuted 1-2).
- (Spike) StellarBroker "parallel same-ledger execution proves Classic legs are executed" (refuted 1-2).
- (Spike) Soroswap aggregator "routes only Soroban AMMs" (0-3); "only Soroswap on mainnet" (0-3); "adapters give no evidence of Classic coverage" (1-2). Net: Classic absence unproven either way.
- (Spike) LumAgg "Classic never executed" (0-3, fallback qualifier).
- (Spike) Stabble "touches Classic only through SAC" (0-3, over-inference).
- (Spike) SCF v7 "$300K lifetime, 10/20/30/40 tranches" (1-2); "Integration track fits a cross-layer router" (0-3).

## Appendix B: primary sources
- LumAgg: communityfund.stellar.org/project/reczBHQOhk4JLhpnp · /submissions/recFRG56TbGtuXbMt · github.com/ligulfzhou/stellar-dex-agg
- WOWMAX: communityfund.stellar.org/submissions/recYYnklyzTFFvASl
- The Strategists: communityfund.stellar.org/submissions/reckfq6k2nbFdORy0
- XCCY: communityfund.stellar.org/submissions/recYG4H2aBA5lJSnG
- Bluechip: communityfund.stellar.org/submissions/recbX8pYYdcArFEPe
- Dig: communityfund.stellar.org/submissions/recJYN4fvS3EaRjp7
- Single-op rule: Stellar docs, "operations and transactions" and "invoking contracts with transactions"
- Path payments: developers.stellar.org/docs/build/guides/transactions/path-payments
- Data: developers.stellar.org/docs/data/apis · /data/indexers/indexer-providers · /data/analytics/hubble · docs.allium.so/changelog/deprecated-stellar-v1
- Ecosystem context: stellar.org/blog/ecosystem/what-the-defi-is-happening-on-stellar · stellar.org/blog/developers/composability-on-stellar-from-concept-to-reality
- Drips Wave: drips.network/wave · docs.drips.network/wave
- Spike sources: github.com/stellar-broker · developers.stellar.org/meetings/2025/02/13 · github.com/Lum-Agg/stellar-dex-agg · github.com/soroswap/docs/issues/47 · docs.soroswap.finance/01-concepts/aggregator · communityfund.stellar.org/submissions/recYIEeYnMBmuYBmT (Stabble) · developers.stellar.org/docs/build/smart-contracts/example-contracts/liquidity-pool · developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools · developers.stellar.org/docs/data/apis/horizon/api-reference/aggregations/paths · stellar.org/case-studies/franklin-templeton · communityfund.stellar.org/awards
