# Contributing to Sluice

Thanks for helping. Sluice routes Stellar liquidity across Classic and Soroban and builds transactions that real wallets sign on mainnet, so changes are held to a "show it works" standard rather than a "looks right" one.

Read the [README](./README.md) first for the layout and the honest limits, and [PRD.md](./PRD.md) for scope. Anything under "Not built" or "Honest limits" in the README is a fair place to start.

## Finding something to work on

- Look for issues labelled `good first issue` (small and self-contained) or `help wanted` (larger).
- Comment on an issue before you start, so two people do not build the same thing. One issue per pull request.
- For anything not covered by an issue (a new venue, an API change, a change to ranking), open an issue first and describe the approach. The ranking policy and the atomicity rules are deliberate; changing them needs a discussion.

## Set up

Requirements: Node 22, pnpm 10 (`corepack enable` picks the right one), and for contract work a Rust toolchain with the `wasm32v1-none` target and `stellar-cli`.

```bash
pnpm install
pnpm build          # packages build in dependency order, then the web app
pnpm start          # API and web app on http://localhost:8787
```

For development run `pnpm dev` (API on :8787) and `pnpm dev:web` (Vite on :5173, proxying `/v1`). Copy `.env.example` to `.env` to change endpoints. Use your own `RPC_URL` if the public one rate-limits you. If fetch fails with `ETIMEDOUT`, set `SLUICE_IPV4_FIRST=1`.

## Before you open a pull request

Run what CI runs:

```bash
pnpm build
pnpm typecheck
pnpm test                       # core, api, sdk and web unit tests
cd contracts && cargo test      # only if you touched contracts/
```

The browser checks run against live mainnet quotes and sign nothing:

```bash
PW_CHANNEL=chrome pnpm e2e      # uses an installed Chrome
# or: pnpm --filter @sluice/web exec playwright install chromium && pnpm e2e
```

Run them if you touched `apps/web`. If CI's e2e job fails for a reason unrelated to your change (a venue was down), say so in the pull request instead of re-running until it is green.

The contract must be built with `stellar contract build --manifest-path router/Cargo.toml` from `contracts/`; plain `cargo build` is refused by soroban-sdk 28.

## What a good change looks like

- **Tests with the change.** A new code path gets a test. A bug fix gets a test that fails without the fix. Core tests use a table-driven fake venue (`fakeSource` in `packages/core/test/helpers.ts`); API tests build the app with injected dependencies, so no network is needed.
- **Evidence for anything that touches a chain.** If you change how a transaction is built, include what you ran and what came back: a simulation against mainnet, a testnet hash from `pnpm w0:testnet-flow`, or the output of a probe in `scripts/`. "It should work" is not enough. Never put a mainnet private key anywhere, and test signing only with throwaway testnet keys.
- **Claims match code.** The README lists what is and is not verified. If your change makes one of those statements untrue, change the statement in the same pull request. Do not describe something as working that you did not run.
- **Small and focused.** Do not mix a refactor with a behaviour change. Match the surrounding style: no new dependency without a reason in the pull request.
- **Amounts are `bigint` stroops internally and decimal strings at the API edge.** Do not use floating point for money.
- **The server never signs and never holds a key.** Changes that would break this will not be merged.

## Adding a venue

A venue is a quote source plus, if it can be executed, a transaction builder. The Soroswap adapter is the shortest working example.

1. **Quote source.** Add `packages/core/src/sources/<venue>.ts` exporting a function that returns a `QuoteSource` (see `packages/core/src/types.ts`): an `id`, a `layer`, and `quote(req)` returning a `Leg` or `null` when the venue cannot route the pair. Throw only on transport errors. Put whatever the builder needs later in `leg.raw` and export a type for it. Export the source from `packages/core/src/index.ts`.
2. **Register it.** Add it to `defaultSources` in `packages/api/src/app.ts`. The venue id then works with `DISABLED_VENUES` automatically.
3. **Execution builder.** Add `build<Venue>Swap` to `packages/core/src/execute/soroban.ts` (or `classic.ts`), then handle your venue id in `planExecution` in `packages/core/src/execute/plan.ts`. Without that branch the route is returned as `unsupported` and the web app will not offer to sign it, which is the correct state for an unverified venue.
4. **Prove it.** Quote and build against mainnet and show that the simulated output matches the quote (see `scripts/w0-venue-sim.ts`). A venue that quotes but cannot execute must not ship enabled.
5. **Tests.** Cover the quote parsing, the `null` cases, and the builder's operation arguments.
6. **README.** Add the venue to the layout table and note any limits.

Atomic multi-venue chains through the Sluice router contract are a separate step (`chainVenues`, `contracts/router`) and need contract changes and tests as well.

## Commits and pull requests

- Write the commit subject in the imperative and say what changed and why in one line (for example `Retry a hung name lookup on a timer`). Add a body when the reason is not obvious.
- Fill in the pull request template. Link the issue it closes.
- Keep the branch rebased on `main`. Do not commit `.env`, `dist/`, or `target/`.

## Reporting bugs and security issues

Bugs go in an issue using the template. **Do not open a public issue for a security problem**; follow [SECURITY.md](./SECURITY.md).

## License

By contributing you agree your work is released under the [MIT License](./LICENSE). Do not copy code from projects with an incompatible license. Phoenix is GPL-3.0, so this repo calls Phoenix on-chain through its public interface and copies none of its code. Follow the same rule for new venues.
